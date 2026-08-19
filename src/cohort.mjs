import { createHash } from "node:crypto";
import { stableJson } from "./benchmark-preflight.mjs";
import { validateTrace } from "./trace.mjs";

export const COHORT_SCHEMA_VERSION = 1;
export const MINIMUM_BASELINE_TASKS = 30;

const EVIDENCE_CLASSES = new Set(["planning", "observed_benchmark"]);
const TASK_STATUSES = new Set(["planned", "collected", "excluded"]);
const TEST_STATUSES = new Set(["passed", "failed"]);
const FAILURE_CLASSES = new Set(["none", "oracle", "environment", "pre_existing", "unknown"]);
const ORACLE_STATUSES = new Set(["passed", "failed"]);

export class CohortValidationError extends Error {
  constructor(errors) {
    super(`Invalid baseline cohort: ${errors.map(({ path, message }) => `${path} ${message}`).join("; ")}`);
    this.name = "CohortValidationError";
    this.errors = errors;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function error(errors, path, message) {
  errors.push({ path, message });
}

function requiredString(errors, value, path) {
  if (!nonEmptyString(value)) error(errors, path, "must be a non-empty string");
}

function digest(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function environmentManifestDigest(manifest) {
  return digest(manifest);
}

export function oracleReportDigest(report) {
  return digest(report);
}

export function validateCohortManifest(cohort) {
  const errors = [];
  if (!isObject(cohort)) return [{ path: "cohort", message: "must be an object" }];
  if (cohort.schema_version !== COHORT_SCHEMA_VERSION) error(errors, "schema_version", `must be ${COHORT_SCHEMA_VERSION}`);
  requiredString(errors, cohort.cohort_id, "cohort_id");
  if (!Number.isInteger(cohort.cohort_version) || cohort.cohort_version < 1) error(errors, "cohort_version", "must be a positive integer");
  if (!EVIDENCE_CLASSES.has(cohort.evidence_class)) error(errors, "evidence_class", "must be planning or observed_benchmark");
  if (!isObject(cohort.repository)) {
    error(errors, "repository", "must be an object");
  } else {
    requiredString(errors, cohort.repository.identity, "repository.identity");
    if (cohort.repository.kind !== "coding-agent") error(errors, "repository.kind", "must be coding-agent");
  }
  if (!/^[a-f0-9]{64}$/i.test(cohort.environment_manifest_digest ?? "")) {
    error(errors, "environment_manifest_digest", "must be a 64-character SHA-256 digest");
  }
  if (!Number.isInteger(cohort.minimum_baseline_tasks) || cohort.minimum_baseline_tasks < MINIMUM_BASELINE_TASKS) {
    error(errors, "minimum_baseline_tasks", `must be at least ${MINIMUM_BASELINE_TASKS}`);
  }
  if (!Array.isArray(cohort.tasks)) {
    error(errors, "tasks", "must be an array");
    return errors;
  }

  const taskIds = new Set();
  cohort.tasks.forEach((task, index) => {
    const path = `tasks[${index}]`;
    if (!isObject(task)) {
      error(errors, path, "must be an object");
      return;
    }
    requiredString(errors, task.task_id, `${path}.task_id`);
    if (taskIds.has(task.task_id)) error(errors, `${path}.task_id`, "must be unique");
    taskIds.add(task.task_id);
    if (!TASK_STATUSES.has(task.status)) error(errors, `${path}.status`, "must be planned, collected, or excluded");
    if (task.quality_claim_eligible !== undefined) {
      error(errors, `${path}.quality_claim_eligible`, "is derived by the auditor and must not be declared");
    }
    if (task.status === "excluded") {
      requiredString(errors, task.exclusion_reason, `${path}.exclusion_reason`);
      return;
    }
    if (task.status === "planned") return;
    requiredString(errors, task.trace_id, `${path}.trace_id`);
    requiredString(errors, task.trace_path, `${path}.trace_path`);
    requiredString(errors, task.oracle_report_path, `${path}.oracle_report_path`);
    if (!/^[a-f0-9]{64}$/i.test(task.oracle_report_sha256 ?? "")) {
      error(errors, `${path}.oracle_report_sha256`, "must be a 64-character SHA-256 digest");
    }
    if (!/^[a-f0-9]{64}$/i.test(task.oracle_definition_sha256 ?? "")) {
      error(errors, `${path}.oracle_definition_sha256`, "must be a 64-character SHA-256 digest");
    }
    if (!/^[a-f0-9]{40}$/i.test(task.repository_commit ?? "")) {
      error(errors, `${path}.repository_commit`, "must be a 40-character Git revision");
    }
    if (!/^[a-f0-9]{64}$/i.test(task.environment_manifest_digest ?? "")) {
      error(errors, `${path}.environment_manifest_digest`, "must be a 64-character SHA-256 digest");
    }
    if (!isObject(task.evidence)) {
      error(errors, `${path}.evidence`, "must be an object");
      return;
    }
    if (task.evidence.environment_status !== "eligible") error(errors, `${path}.evidence.environment_status`, "must be eligible");
    if (task.evidence.install_status !== "passed") error(errors, `${path}.evidence.install_status`, "must be passed");
    if (task.evidence.build_status !== "passed") error(errors, `${path}.evidence.build_status`, "must be passed");
    if (!TEST_STATUSES.has(task.evidence.test_status)) error(errors, `${path}.evidence.test_status`, "must be passed or failed");
    if (task.evidence.clean_worktree !== true) error(errors, `${path}.evidence.clean_worktree`, "must be true");
    if (!FAILURE_CLASSES.has(task.evidence.failure_class)) error(errors, `${path}.evidence.failure_class`, "must be a supported failure class");
    if (task.evidence.oracle_status !== undefined || task.evidence.oracle_failure_signatures !== undefined) {
      error(errors, `${path}.evidence`, "must not declare oracle results; reference an independent oracle report");
    }
  });
  return errors;
}

function oracleEvidenceReasons(task, environment, oracleReport) {
  const reasons = [];
  if (!isObject(oracleReport)) return ["oracle_report_missing"];
  if (oracleReportDigest(oracleReport) !== task.oracle_report_sha256) reasons.push("oracle_report_digest_mismatch");
  if (oracleReport.schema_version !== 1 || oracleReport.evidence_class !== "independent_oracle") reasons.push("oracle_report_invalid");
  if (oracleReport.task_id !== task.task_id) reasons.push("oracle_task_id_mismatch");
  if (!/^[a-f0-9]{64}$/i.test(oracleReport.oracle?.definition_sha256 ?? "")) reasons.push("oracle_definition_digest_invalid");
  else if (oracleReport.oracle.definition_sha256 !== task.oracle_definition_sha256) reasons.push("oracle_definition_digest_mismatch");
  if (oracleReport.environment?.benchmark_id !== environment.benchmark_id) reasons.push("oracle_benchmark_mismatch");
  if (oracleReport.environment?.repository_identity !== environment.repository.identity) reasons.push("oracle_repository_mismatch");
  if (oracleReport.environment?.repository_revision !== environment.repository.observed_revision) reasons.push("oracle_revision_mismatch");
  if (oracleReport.environment?.manifest_digest !== environmentManifestDigest(environment)) reasons.push("oracle_environment_manifest_mismatch");
  if (!/^[a-f0-9]{64}$/i.test(oracleReport.workspace?.source_tree_sha256 ?? "")) reasons.push("oracle_workspace_digest_invalid");
  if (!ORACLE_STATUSES.has(oracleReport.result?.status)) reasons.push("oracle_status_invalid");
  const failureSignatures = oracleReport.result?.failure_signatures;
  if (!Array.isArray(failureSignatures) || failureSignatures.some((signature) => !nonEmptyString(signature))) {
    reasons.push("oracle_failure_signatures_invalid");
  } else if (oracleReport.result.status === "passed" && failureSignatures.length > 0) {
    reasons.push("oracle_passed_with_failure_signatures");
  } else if (oracleReport.result.status === "failed" && failureSignatures.length === 0) {
    reasons.push("oracle_failure_signature_missing");
  }
  return reasons;
}

function taskEligibility(task, environment, trace, oracleReport) {
  const reasons = [];
  if (task.status !== "collected") reasons.push(`task_status:${task.status}`);
  if (task.environment_manifest_digest !== environmentManifestDigest(environment)) reasons.push("environment_manifest_mismatch");
  if (task.repository_commit !== environment.repository.observed_revision) reasons.push("repository_revision_mismatch");
  if (task.evidence?.failure_class === "environment") reasons.push("environment_failure");
  if (task.evidence?.failure_class === "pre_existing") reasons.push("pre_existing_failure");
  if (task.evidence?.failure_class === "unknown") reasons.push("unattributed_failure");
  reasons.push(...oracleEvidenceReasons(task, environment, oracleReport));
  if (!trace) {
    reasons.push("trace_missing");
  } else {
    const validation = validateTrace(trace);
    if (!validation.valid) reasons.push("trace_invalid");
    if (trace.trace_id !== task.trace_id) reasons.push("trace_id_mismatch");
    if (trace.task_id !== task.task_id) reasons.push("trace_task_id_mismatch");
    if (trace.mode !== "baseline") reasons.push("trace_mode_not_baseline");
    if (trace.repository !== environment.repository.identity) reasons.push("trace_repository_mismatch");
    if (trace.repository_commit !== environment.repository.observed_revision) reasons.push("trace_revision_mismatch");
    if (trace.completeness !== "complete") reasons.push("trace_incomplete");
  }
  return [...new Set(reasons)].sort();
}

function assertEnvironment(environment) {
  if (!isObject(environment)) throw new Error("Environment manifest must be an object");
  if (environment.schema_version !== 1 || environment.evidence_class !== "benchmark_environment") {
    throw new Error("Environment manifest must be benchmark_environment schema v1");
  }
  if (environment.conclusion?.status !== "eligible") throw new Error("Environment manifest must be eligible");
  if (!nonEmptyString(environment.repository?.identity) || !/^[a-f0-9]{40}$/i.test(environment.repository?.observed_revision ?? "")) {
    throw new Error("Environment manifest must include repository identity and observed revision");
  }
  if (environment.repository.expected_revision !== environment.repository.observed_revision) {
    throw new Error("Environment manifest expected and observed revisions must match");
  }
}

export function auditBaselineCohort({ cohort, environment, traces, oracleReports }) {
  const validationErrors = validateCohortManifest(cohort);
  if (validationErrors.length > 0) throw new CohortValidationError(validationErrors);
  assertEnvironment(environment);
  if (cohort.repository.identity !== environment.repository.identity) throw new Error("Cohort repository identity does not match environment manifest");
  if (cohort.environment_manifest_digest !== environmentManifestDigest(environment)) throw new Error("Cohort environment manifest digest does not match environment manifest");

  const traceMap = traces instanceof Map ? traces : new Map(Object.entries(traces ?? {}));
  const oracleReportMap = oracleReports instanceof Map ? oracleReports : new Map(Object.entries(oracleReports ?? {}));
  const taskReports = cohort.tasks.map((task) => {
    if (task.status !== "collected") {
      return { task_id: task.task_id, status: task.status, quality_claim_eligible: false, reasons: [`task_status:${task.status}`] };
    }
    const reasons = taskEligibility(task, environment, traceMap.get(task.task_id), oracleReportMap.get(task.task_id));
    return { task_id: task.task_id, status: task.status, quality_claim_eligible: reasons.length === 0, reasons };
  });
  const eligibleCount = taskReports.filter((task) => task.quality_claim_eligible).length;
  const deficit = Math.max(0, cohort.minimum_baseline_tasks - eligibleCount);
  const invalidCount = taskReports.filter((task) => task.reasons.some((reason) => reason === "trace_invalid" || reason.startsWith("oracle_"))).length;
  const status = invalidCount > 0 ? "invalid" : deficit > 0 ? "evidence_insufficient" : "ready";
  return {
    schema_version: COHORT_SCHEMA_VERSION,
    cohort: { id: cohort.cohort_id, version: cohort.cohort_version, evidence_class: cohort.evidence_class },
    environment: {
      benchmark_id: environment.benchmark_id,
      repository_identity: environment.repository.identity,
      repository_revision: environment.repository.observed_revision,
      manifest_digest: environmentManifestDigest(environment),
      status: environment.conclusion.status,
    },
    counts: {
      declared_tasks: cohort.tasks.length,
      planned_tasks: taskReports.filter((task) => task.status === "planned").length,
      collected_tasks: taskReports.filter((task) => task.status === "collected").length,
      excluded_tasks: taskReports.filter((task) => task.status === "excluded").length,
      quality_claim_eligible_tasks: eligibleCount,
      required_baseline_tasks: cohort.minimum_baseline_tasks,
      evidence_deficit: deficit,
    },
    tasks: taskReports,
    conclusion: {
      status,
      quality_claim_eligible: status === "ready" && cohort.evidence_class === "observed_benchmark",
      reasons: status === "ready" ? [] : [status === "invalid" ? "invalid_task_evidence" : "minimum_baseline_tasks_not_met"],
    },
  };
}
