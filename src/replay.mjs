import { diagnoseTrace } from "./diagnostics.mjs";
import { assertValidTrace } from "./trace.mjs";

const EVENT_LABELS = Object.freeze({
  diff: "State changed",
  risk: "Risk assessed",
  test_selection: "Tests selected",
  test_result: "Test completed",
  retry: "Retry requested",
  expand: "Scope expanded",
  stop: "Verification stopped",
});

const DIAGNOSTIC_LABELS = Object.freeze({
  exact_repeat: "Exact repeat",
  unattributed_retry: "Unattributed retry",
  necessary_revalidation: "Necessary revalidation",
});

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function display(value, fallback = "Not recorded") {
  if (value === null || value === undefined || value === "") return fallback;
  return escapeHtml(value);
}

function code(value) {
  return `<code>${display(value)}</code>`;
}

function duration(milliseconds) {
  if (milliseconds < 1000) return `${milliseconds} ms`;
  return `${(milliseconds / 1000).toFixed(milliseconds % 1000 === 0 ? 0 : 2)} s`;
}

function timestamp(value) {
  const [date, time] = value.split("T");
  return `${date} ${time.replace("Z", " UTC")}`;
}

function list(values, empty = "None") {
  if (!Array.isArray(values) || values.length === 0) return `<span class="muted">${escapeHtml(empty)}</span>`;
  return `<ul class="compact-list">${values.map((value) => `<li>${code(value)}</li>`).join("")}</ul>`;
}

function fact(term, description) {
  return `<div class="fact"><dt>${escapeHtml(term)}</dt><dd>${description}</dd></div>`;
}

function eventFacts(event) {
  const { data } = event;
  if (event.event_type === "diff") {
    return [
      fact("Changed files", list(data.changed_files)),
      fact("Change kinds", list(data.change_kinds, "Unknown")),
      fact("State", code(data.state_id)),
    ];
  }
  if (event.event_type === "risk") {
    return [
      fact("Risk", `<strong>${display(data.risk_level)}</strong>`),
      fact("Reasons", list(data.reasons)),
      fact("Fallback", data.fallback ? "Yes" : "No"),
    ];
  }
  if (event.event_type === "test_selection") {
    const commands = data.commands.map((command) => `${command.id}: ${command.argv.join(" ")}`);
    return [
      fact("Scope", `${display(data.requested_phase)} &rarr; <strong>${display(data.selected_phase)}</strong>`),
      fact("Workspaces", list(data.affected_workspaces)),
      fact("Commands", list(commands)),
    ];
  }
  if (event.event_type === "test_result") {
    return [
      fact("Command", code(data.command.join(" "))),
      fact("Result", `<strong class="result-${data.exit_code === 0 ? "passed" : "failed"}">${data.exit_code === 0 ? "Passed" : `Failed (exit ${data.exit_code})`}</strong>`),
      fact("Duration", `<strong>${duration(data.duration_ms)}</strong>`),
      fact("Failure", code(data.failure_signature)),
    ];
  }
  if (event.event_type === "retry") {
    return [
      fact("Reason", display(data.reason)),
      fact("From event", `<a href="#event-${data.from_event_index}">#${data.from_event_index}</a>`),
      fact("Attributed", data.attributed ? "Yes" : "No"),
    ];
  }
  if (event.event_type === "expand") {
    return [
      fact("Reason", display(data.reason)),
      fact("From event", `<a href="#event-${data.from_event_index}">#${data.from_event_index}</a>`),
    ];
  }
  return [
    fact("Status", `<strong>${display(data.status)}</strong>`),
    fact("Reason", display(data.reason)),
  ];
}

function diagnosticMarkup(findings) {
  if (findings.length === 0) return "";
  return `<section class="event-diagnostics" aria-label="Event diagnostics">
    <h3>Diagnostics</h3>
    ${findings.map((finding) => `<div class="diagnostic diagnostic-${finding.label}">
      <strong>${DIAGNOSTIC_LABELS[finding.label]}</strong>
      <span>${code(finding.reason_code)}</span>
      <span class="evidence">Evidence ${finding.evidence_event_indexes.map((index) => `<a href="#event-${index}">#${index}</a>`).join(" ")}</span>
    </div>`).join("")}
  </section>`;
}

function rawJson(label, value, open = false) {
  return `<details class="raw"${open ? " open" : ""}>
    <summary>${escapeHtml(label)}</summary>
    <pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>
  </details>`;
}

function eventMarkup(event, findings) {
  const eventFindings = findings.filter((finding) => finding.event_index === event.event_index);
  const classes = ["event", `event-${event.event_type}`];
  if (eventFindings.some((finding) => finding.label === "exact_repeat" || finding.label === "unattributed_retry")) {
    classes.push("event-waste");
  }
  return `<li class="${classes.join(" ")}" id="event-${event.event_index}" data-event-index="${event.event_index}">
    <article>
      <header class="event-header">
        <span class="event-index" aria-label="Event ${event.event_index}">#${event.event_index}</span>
        <div>
          <p class="event-type">${escapeHtml(event.event_type)}</p>
          <h2>${EVENT_LABELS[event.event_type]}</h2>
        </div>
        <time datetime="${escapeHtml(event.timestamp)}">${escapeHtml(timestamp(event.timestamp))}</time>
      </header>
      <dl class="event-facts">${eventFacts(event).join("")}</dl>
      ${diagnosticMarkup(eventFindings)}
      ${rawJson("Complete event data", event)}
    </article>
  </li>`;
}

function metaItem(label, value) {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${display(value)}</dd></div>`;
}

function metric(label, value) {
  return `<dl class="metric"><dt>${escapeHtml(label)}</dt><dd>${display(value)}</dd></dl>`;
}

export function renderTraceReplay(trace) {
  assertValidTrace(trace, { allowPartial: trace?.completeness === "partial" });
  const diagnostics = diagnoseTrace(trace);
  const totalDuration = trace.events
    .filter((event) => event.event_type === "test_result")
    .reduce((total, event) => total + event.data.duration_ms, 0);
  const resultCount = trace.events.filter((event) => event.event_type === "test_result").length;
  const stop = trace.events.find((event) => event.event_type === "stop") ?? null;
  const envelope = { ...trace };
  delete envelope.events;

  const warningMarkup = trace.warnings?.length
    ? `<aside class="notice warning" role="status"><strong>Incomplete evidence</strong><span>${trace.warnings.map(escapeHtml).join(", ")}</span></aside>`
    : "";
  const wasteMarkup = diagnostics.first_candidate_waste_event_index === null
    ? `<aside class="notice clear" role="status"><strong>No candidate waste point</strong><span>Deterministic rules found no low-information repeat.</span></aside>`
    : `<aside class="notice waste" role="status"><strong>First candidate waste point</strong><a href="#event-${diagnostics.first_candidate_waste_event_index}">Inspect event #${diagnostics.first_candidate_waste_event_index}</a></aside>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>${escapeHtml(trace.task_id)} | VerifyTrace replay</title>
  <style>
    :root {
      color-scheme: light;
      --paper: #f7f7f4;
      --surface: #ffffff;
      --ink: #171a1f;
      --muted: #626971;
      --line: #d8dadd;
      --line-strong: #a9afb6;
      --teal: #0b6b65;
      --green: #146c43;
      --red: #b42318;
      --amber: #8a4b08;
      --blue: #2457a6;
      --focus: #005fcc;
      --radius: 6px;
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      background: var(--paper);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 15px;
      line-height: 1.55;
      letter-spacing: 0;
    }
    a { color: var(--blue); text-underline-offset: 3px; }
    a:hover { color: #163f7d; }
    a:focus-visible, summary:focus-visible { outline: 3px solid var(--focus); outline-offset: 3px; }
    code, pre, .event-type, .eyebrow, .metric dt, .metadata dt, .event-index {
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
    }
    code { overflow-wrap: anywhere; }
    .page-header { border-bottom: 1px solid var(--line); background: var(--surface); }
    .page-header-inner, main { width: min(1120px, calc(100% - 40px)); margin: 0 auto; }
    .page-header-inner { padding: 36px 0 30px; }
    .eyebrow { margin: 0 0 8px; color: var(--teal); font-size: 12px; font-weight: 700; text-transform: uppercase; }
    h1 { margin: 0; font-size: 30px; line-height: 1.2; letter-spacing: 0; overflow-wrap: anywhere; }
    .lede { max-width: 760px; margin: 10px 0 0; color: var(--muted); }
    .metadata { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px 24px; margin: 26px 0 0; }
    .metadata div { min-width: 0; }
    .metadata dt, .metric dt { color: var(--muted); font-size: 11px; font-weight: 700; text-transform: uppercase; }
    .metadata dd { margin: 3px 0 0; font-weight: 650; overflow-wrap: anywhere; }
    main { padding: 28px 0 64px; }
    .summary-band { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-block: 1px solid var(--line-strong); }
    .metric { padding: 17px 14px; border-right: 1px solid var(--line); }
    .metric:last-child { border-right: 0; }
    .metric dd { margin: 2px 0 0; font-size: 21px; font-weight: 750; overflow-wrap: anywhere; }
    .notices { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 22px 0 28px; }
    .notice { min-height: 72px; padding: 14px 16px; border: 1px solid var(--line-strong); border-left-width: 5px; border-radius: var(--radius); background: var(--surface); }
    .notice strong, .notice span, .notice a { display: block; }
    .notice span, .notice a { margin-top: 3px; }
    .notice.clear { border-left-color: var(--green); }
    .notice.waste { border-left-color: var(--red); }
    .notice.warning { border-left-color: var(--amber); }
    .timeline-heading { margin: 0 0 18px; font-size: 19px; }
    .timeline { position: relative; margin: 0; padding: 0 0 0 44px; list-style: none; }
    .timeline::before { position: absolute; inset: 18px auto 18px 15px; width: 2px; background: var(--line-strong); content: ""; }
    .event { position: relative; margin: 0 0 16px; scroll-margin-top: 18px; }
    .event::before { position: absolute; top: 21px; left: -35px; width: 12px; height: 12px; border: 3px solid var(--paper); border-radius: 50%; background: var(--teal); box-shadow: 0 0 0 1px var(--line-strong); content: ""; }
    .event-test_result::before { background: var(--green); }
    .event-retry::before, .event-expand::before { background: var(--amber); }
    .event-stop::before { background: var(--ink); }
    .event-waste::before { background: var(--red); }
    .event article { overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
    .event-waste article { border-color: #d92d20; box-shadow: inset 4px 0 0 var(--red); }
    .event-header { display: grid; grid-template-columns: 48px minmax(0, 1fr) auto; align-items: center; gap: 14px; padding: 17px 18px; border-bottom: 1px solid var(--line); }
    .event-index { display: grid; width: 40px; height: 40px; place-items: center; border: 1px solid var(--line-strong); border-radius: 50%; font-size: 12px; font-weight: 700; }
    .event-type { margin: 0; color: var(--teal); font-size: 11px; font-weight: 700; text-transform: uppercase; }
    .event-header h2 { margin: 1px 0 0; font-size: 17px; line-height: 1.25; letter-spacing: 0; }
    time { color: var(--muted); font-size: 12px; white-space: nowrap; }
    .event-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin: 0; padding: 16px 18px; gap: 14px 22px; }
    .fact { min-width: 0; }
    .fact dt { margin-bottom: 4px; color: var(--muted); font-size: 11px; font-weight: 700; text-transform: uppercase; }
    .fact dd { margin: 0; overflow-wrap: anywhere; }
    .compact-list { margin: 0; padding: 0; list-style: none; }
    .compact-list li + li { margin-top: 4px; }
    .muted { color: var(--muted); }
    .result-passed { color: var(--green); }
    .result-failed { color: var(--red); }
    .event-diagnostics { padding: 14px 18px; border-top: 1px solid var(--line); }
    .event-diagnostics h3 { margin: 0 0 9px; font-size: 12px; text-transform: uppercase; }
    .diagnostic { display: grid; grid-template-columns: minmax(130px, auto) minmax(0, 1fr) auto; gap: 12px; align-items: baseline; padding: 9px 11px; border-left: 4px solid var(--amber); background: #fff9ed; }
    .diagnostic + .diagnostic { margin-top: 7px; }
    .diagnostic-exact_repeat, .diagnostic-unattributed_retry { border-left-color: var(--red); background: #fff3f2; }
    .diagnostic-necessary_revalidation { border-left-color: var(--green); background: #effaf4; }
    .evidence { text-align: right; white-space: nowrap; }
    .evidence a + a { margin-left: 7px; }
    .raw { border-top: 1px solid var(--line); }
    .raw summary { min-height: 44px; padding: 11px 18px; color: var(--blue); cursor: pointer; font-weight: 700; }
    .raw[open] summary { border-bottom: 1px solid var(--line); }
    pre { max-height: 420px; margin: 0; padding: 16px 18px; overflow: auto; background: #20242a; color: #f3f5f7; font-size: 12px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
    .envelope { margin-top: 24px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
    .envelope + .envelope { margin-top: 12px; }
    .footer { margin-top: 20px; color: var(--muted); font-size: 12px; }
    @media (max-width: 760px) {
      .page-header-inner, main { width: min(100% - 24px, 1120px); }
      .page-header-inner { padding: 25px 0 22px; }
      h1 { font-size: 24px; }
      .metadata { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 13px 18px; }
      .summary-band { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .metric:nth-child(2) { border-right: 0; }
      .metric:nth-child(-n + 2) { border-bottom: 1px solid var(--line); }
      .notices { grid-template-columns: 1fr; }
      .timeline { padding-left: 28px; }
      .timeline::before { left: 8px; }
      .event::before { left: -25px; }
      .event-header { grid-template-columns: 40px minmax(0, 1fr); gap: 10px; padding: 14px; }
      .event-index { width: 36px; height: 36px; }
      time { grid-column: 2; white-space: normal; }
      .event-facts { grid-template-columns: 1fr; padding: 14px; }
      .diagnostic { grid-template-columns: 1fr; gap: 4px; }
      .evidence { text-align: left; white-space: normal; }
    }
    @media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
    @media print {
      body { background: #fff; }
      .page-header-inner, main { width: 100%; }
      .event article, .envelope { break-inside: avoid; }
    }
  </style>
</head>
<body>
  <header class="page-header">
    <div class="page-header-inner">
      <p class="eyebrow">VerifyTrace v${trace.schema_version} / ${display(trace.mode)}</p>
      <h1>${escapeHtml(trace.task_id)}</h1>
      <p class="lede">Policy ${display(trace.policy.name)} / ${display(trace.policy.version)} | ${display(trace.source.format)} | ${display(trace.completeness)}</p>
      <dl class="metadata">
        ${metaItem("Trace", trace.trace_id)}
        ${metaItem("Repository", trace.repository)}
        ${metaItem("Commit", trace.repository_commit)}
        ${metaItem("Harness / model", [trace.harness, trace.model].filter(Boolean).join(" / ") || null)}
      </dl>
    </div>
  </header>
  <main>
    <section class="summary-band" aria-label="Replay summary">
      ${metric("Events", trace.events.length)}
      ${metric("Test results", resultCount)}
      ${metric("Test duration", duration(totalDuration))}
      ${metric("Stop status", stop?.data.status ?? "Missing")}
    </section>
    <section class="notices" aria-label="Replay findings">
      ${wasteMarkup}
      ${warningMarkup || `<aside class="notice clear" role="status"><strong>Trace complete</strong><span>An explicit stop event is present.</span></aside>`}
    </section>
    <h2 class="timeline-heading">Event timeline</h2>
    <ol class="timeline">
      ${trace.events.map((event) => eventMarkup(event, diagnostics.findings)).join("\n")}
    </ol>
    <section class="envelope" aria-label="Trace envelope">
      ${rawJson("Complete trace envelope", envelope)}
    </section>
    <section class="envelope" aria-label="Diagnostic result">
      ${rawJson("Complete diagnostic result", diagnostics)}
    </section>
    <p class="footer">Source ${display(trace.source.source_ref)} | ${trace.source.record_count} records | diagnostic ruleset v${diagnostics.ruleset_version}</p>
  </main>
</body>
</html>`;
}
