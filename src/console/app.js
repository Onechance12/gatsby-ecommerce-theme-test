(function () {
  "use strict";

  const ENDPOINTS = Object.freeze({
    meta: "/api/v1/meta",
    session: "/hcn/auth/session",
    logout: "/hcn/auth/logout",
    connectorsStatus: "/hcn/api/v1/connectors/status",
    googleConnectStart: "/hcn/connect/google/start",
    quoLine: "/hcn/api/v1/connectors/quo-line",
    assistantTurns: "/hcn/api/v1/assistant/turns",
    managementSweep: "/hcn/api/v1/management-sweep",
    workCenter: "/hcn/api/v1/work-center",
    fileReview: "/hcn/api/v1/file-review",
    actionPrepare: "/hcn/api/v1/action-plans/prepare",
    actionList: "/hcn/api/v1/action-plans/list",
    actionDetail: "/hcn/api/v1/action-plans/detail",
    actionExecute: "/hcn/api/v1/action-plans/execute",
    actionInvalidate: "/hcn/api/v1/action-plans/invalidate",
    receiptList: "/hcn/api/v1/action-receipts/list",
    receiptDetail: "/hcn/api/v1/action-receipts/detail"
  });

  const WORK_CENTER_CAPABILITY = "hcn.work_center.read";
  const ASSISTANT_TURN_CAPABILITY = "hcn.assistant.turn";
  const ASSISTANT_MODES = new Set(["auto", "deep"]);
  const ASSISTANT_ROUTES = new Set([
    "deterministic",
    "standard",
    "deep",
    "codex_escalation"
  ]);
  const ASSISTANT_ROUTE_PROFILES = Object.freeze({
    deterministic: Object.freeze({
      profileId: "hcn.deterministic.v1",
      modelUsed: false
    }),
    standard: Object.freeze({
      profileId: "hcn.openai.gpt-5.6-sol.medium.v1",
      modelUsed: true
    }),
    deep: Object.freeze({
      profileId: "hcn.openai.gpt-5.6-sol.high.v1",
      modelUsed: true
    }),
    codex_escalation: Object.freeze({
      profileId: "hcn.codex-operator-escalation.v1",
      modelUsed: false
    })
  });
  const ASSISTANT_ROUTE_REASON_CODES = Object.freeze({
    deterministic: Object.freeze([
      "fact_only_work_center",
      "fact_only_management_sweep",
      "fact_only_file_status"
    ]),
    standard: Object.freeze([
      "ordinary_interpretation",
      "ordinary_drafting",
      "general_assistance"
    ]),
    deep: Object.freeze([
      "explicit_deep_review",
      "multi_source_contradiction",
      "settlement_review",
      "policy_review",
      "coverage_review",
      "claim_strategy",
      "complex_document",
      "high_stakes_ambiguity"
    ]),
    codex_escalation: Object.freeze([
      "explicit_codex_request",
      "unsupported_live_call",
      "unsupported_upload",
      "unsupported_delete",
      "unsupported_financial_action",
      "unsupported_legal_action",
      "unsupported_capability",
      "missing_required_evidence"
    ])
  });
  const ASSISTANT_SOURCE_KEYS = new Set([
    "jobnimbus",
    "gmail",
    "quo",
    "google_calendar",
    "retell",
    "action_plan"
  ]);
  const ASSISTANT_SOURCE_STATUSES = new Set([
    "fresh",
    "complete",
    "partial",
    "stale",
    "incomplete",
    "unavailable",
    "not_evaluated",
    "not_configured",
    "unknown",
    "pending_human_review"
  ]);
  const MANAGEMENT_SWEEP_CAPABILITY = "hcn.management_sweep.read";
  const CONNECTOR_READ_CAPABILITY = "hcn.connectors.read";
  const GOOGLE_LINK_CAPABILITY = "hcn.connectors.google.link";
  const QUO_LINE_LINK_CAPABILITY = "hcn.connectors.quo_line.link";
  const FILE_REVIEW_CAPABILITY = "hcn.file.review";
  const ACTION_PREPARE_CAPABILITY = "hcn.action_plans.prepare";
  const ACTION_READ_CAPABILITY = "hcn.action_plans.read";
  const ACTION_EXECUTE_CAPABILITY = "hcn.action_plans.execute";
  const ACTION_INVALIDATE_CAPABILITY = "hcn.action_plans.invalidate";
  const RECEIPT_READ_CAPABILITY = "hcn.action_receipts.read";
  const FILE_REF = /^subject_[a-f0-9]{32}$/;
  const TASK_REF = /^ref_[a-f0-9]{32}$/;
  const EVIDENCE_REF = /^ref_[a-f0-9]{32}$/;
  const PLAN_ID = /^plan_[a-f0-9]{32}$/;
  const BATCH_REF = /^batch_[a-f0-9]{32}$/;
  const APPROVAL_DIGEST = /^[a-f0-9]{64}$/;
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const ISO_INSTANT =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const E164_PHONE = /^\+[1-9]\d{7,14}$/;
  const SESSION_IDLE_HEADER = "x-hcn-session-idle-expires-at";
  const SESSION_ABSOLUTE_HEADER = "x-hcn-session-expires-at";
  const MAX_TIMER_DELAY_MS = 2_147_000_000;
  const MAX_ACTIONS = 12;
  const WORK_CENTER_PAGE_SIZE = 25;
  const GOOGLE_CALLBACK_OUTCOMES = new Set([
    "connected",
    "cancelled",
    "provider_error",
    "access_denied",
    "invalid_request",
    "temporarily_unavailable"
  ]);
  const AUTH_CALLBACK_OUTCOMES = new Set([
    "access_denied",
    "cancelled",
    "invalid_request",
    "provider_error",
    "temporarily_unavailable"
  ]);
  const CONNECTION_STATUSES = new Set([
    "connected",
    "not_connected",
    "unavailable"
  ]);

  const ACTION_LABELS = Object.freeze({
    "jobnimbus.create_note": "Create JobNimbus note",
    "jobnimbus.create_task": "Create JobNimbus task",
    "jobnimbus.update_task": "Update JobNimbus task",
    "jobnimbus.update_status": "Change JobNimbus status",
    "jobnimbus.update_contact": "Set JobNimbus date of loss",
    "jobnimbus.create_calendar_event": "Create JobNimbus appointment",
    "jobnimbus.update_calendar_event": "Update JobNimbus appointment",
    "gmail.create_draft": "Create Gmail draft",
    "gmail.send": "Send reviewed Gmail draft",
    "quo.send_text": "Send Quo text"
  });

  const PLAN_STATUSES = new Set([
    "pending",
    "executing",
    "executed",
    "completed_pending_verification",
    "partial_failure",
    "blocked_duplicate",
    "failed",
    "reconciliation_required",
    "superseded",
    "expired",
    "invalidated"
  ]);

  const RECEIPT_STATUSES = new Set([
    "executing",
    "executed",
    "completed_pending_verification",
    "partial_failure",
    "blocked_duplicate",
    "failed",
    "reconciliation_required"
  ]);

  const ATTENTION_LABELS = Object.freeze({
    missing_adjuster: "Adjuster missing",
    missing_claim_number: "Claim number missing",
    missing_date_of_loss: "Date of loss missing",
    missing_policy_number: "Policy number missing"
  });

  const SWEEP_SOURCE_LABELS = Object.freeze({
    gmail: "Gmail",
    google_calendar: "Google Calendar",
    jobnimbus: "JobNimbus",
    quo: "Quo",
    retell: "Retell"
  });

  const LANE_LABELS = Object.freeze({
    awaiting_response: "Waiting for a response",
    document_review_required: "Document needs review",
    missing_adjuster: "Adjuster information is missing",
    missing_claim_number: "Claim number is missing",
    missing_date_of_loss: "Date of loss is missing",
    missing_policy_number: "Policy number is missing",
    overdue_task: "Task is overdue",
    reply_required: "Reply needed",
    source_partial: "Source evidence is partial",
    source_stale: "Source evidence is stale",
    source_unavailable: "Source is unavailable",
    task_due_today: "Task is due today"
  });

  const CONNECTOR_LABELS = Object.freeze({
    carrierFollowUp: "Carrier follow-up",
    claimFiling: "Claim filing",
    clientCoordinator: "Client coordinator",
    gmail: "Gmail",
    googleCalendar: "Google Calendar",
    googleOAuth: "Google sign-in",
    jobNimbus: "JobNimbus",
    managementSweep: "10 × 3 sweep",
    quo: "Quo",
    realtimeVoice: "Realtime voice"
  });

  const GATE_LABELS = Object.freeze({
    carrierFollowUpCalls: "Carrier follow-up calls",
    claimFilingCalls: "Claim filing calls",
    clientCoordinatorAppointmentCalls: "Appointment calls",
    clientCoordinatorExpandedCalls: "Expanded coordinator calls",
    externalWrites: "External writes",
    hcnActionExecution: "HCN action execution",
    gmailSend: "Gmail sending",
    quoSend: "Quo sending",
    realtimeVoiceCalls: "Realtime voice calls"
  });

  const CAPABILITY_GROUP_LABELS = Object.freeze({
    claims: "Claims",
    gmail: "Gmail",
    handoff: "Handoffs",
    hcn: "HCN console",
    identity: "Identity",
    jobnimbus: "JobNimbus",
    operations: "Operations",
    platform: "Platform",
    quo: "Quo",
    retell: "Call workflows",
    scheduling: "Scheduling",
    voice: "Voice",
    weather: "Weather"
  });

  const state = {
    loading: false,
    meta: null,
    session: null,
    metaError: null,
    sessionError: null,
    managementSweep: null,
    managementSweepLoading: false,
    managementSweepController: null,
    managementSweepExpiryTimer: null,
    connections: null,
    connectionsLoading: false,
    connectionsController: null,
    quoController: null,
    quoMutationLoading: false,
    quoChallengePending: false,
    authCallbackOutcome: "",
    googleCallbackOutcome: "",
    workCenter: null,
    workCenterOffset: 0,
    selectedFileRef: null,
    fileReview: null,
    workCenterLoading: false,
    fileLoading: false,
    workCenterController: null,
    fileController: null,
    actionController: null,
    receiptController: null,
    actionDraft: [],
    actionPlans: null,
    selectedPlanId: null,
    actionPlan: null,
    actionLoading: false,
    receipts: null,
    selectedReceiptPlanId: null,
    receipt: null,
    receiptLoading: false,
    assistantController: null,
    assistantLoading: false,
    assistantPlanId: null,
    assistantPreparedPlanCount: 0,
    sessionDeadlineMs: 0,
    sessionExpiryTimer: null
  };

  const elements = {};

  document.addEventListener("DOMContentLoaded", initialize);

  function initialize() {
    state.authCallbackOutcome = consumeAuthCallbackOutcome();
    state.googleCallbackOutcome = consumeGoogleCallbackOutcome();
    [
      "connection-status",
      "connection-status-text",
      "sign-in-action",
      "home-auth-alert",
      "sign-out-action",
      "retry-action",
      "readiness-summary",
      "load-message",
      "readiness-score",
      "readiness-label",
      "connector-metric",
      "connector-metric-detail",
      "gate-metric",
      "gate-metric-detail",
      "capability-metric",
      "capability-metric-detail",
      "build-metric",
      "build-metric-detail",
      "connectors-card-status",
      "controls-card-status",
      "connector-list",
      "gate-list",
      "drift-message",
      "boundary-list",
      "build-card-status",
      "build-details",
      "identity-badge",
      "capability-summary",
      "capability-groups",
      "freshness-text",
      "home-next-action",
      "home-next-detail",
      "home-work-status",
      "home-sweep-status",
      "home-connections-status",
      "assistant-alert",
      "assistant-transcript",
      "assistant-form",
      "assistant-prompt",
      "assistant-send",
      "assistant-mode-auto",
      "assistant-mode-deep",
      "assistant-pilot-route",
      "assistant-pilot-sources",
      "assistant-pilot-plans",
      "assistant-review-action",
      "management-sweep-refresh",
      "management-sweep-hero-message",
      "management-sweep-status",
      "management-sweep-adjuster-count",
      "management-sweep-file-count",
      "management-sweep-completeness",
      "management-sweep-generated",
      "management-sweep-section-status",
      "management-sweep-alert",
      "management-sweep-source-health",
      "management-sweep-locked",
      "management-sweep-workspace",
      "company-worst-count",
      "company-worst-list",
      "adjuster-sweep-list",
      "management-sweep-exclusions",
      "management-sweep-exclusion-count",
      "management-sweep-exclusion-list",
      "work-center-summary",
      "work-center-status",
      "work-center-refresh",
      "work-center-sign-in",
      "work-center-alert",
      "work-center-locked",
      "work-center-workspace",
      "work-center-count",
      "work-center-freshness",
      "work-center-list",
      "work-center-previous",
      "work-center-page",
      "work-center-next",
      "file-placeholder",
      "file-review",
      "file-back",
      "file-job-number",
      "file-name",
      "file-stage",
      "file-evidence-status",
      "file-refresh",
      "file-alert",
      "file-freshness",
      "source-health",
      "key-facts",
      "file-intelligence-urgency",
      "file-intelligence-summary",
      "file-intelligence-workflows",
      "file-intelligence-actions",
      "priority-count",
      "priority-lane",
      "today-count",
      "today-lane",
      "waiting-count",
      "waiting-lane",
      "recent-tasks",
      "recent-documents",
      "recent-gmail",
      "recent-quo",
      "recent-activities",
      "action-composer",
      "action-composer-count",
      "action-composer-alert",
      "action-form",
      "action-type",
      "action-note",
      "create-task-title",
      "create-task-description",
      "create-task-due-date",
      "update-task-ref",
      "update-task-title",
      "update-task-description",
      "update-task-due-date",
      "update-task-completed",
      "action-status",
      "action-date-of-loss",
      "create-event-title",
      "create-event-description",
      "create-event-start",
      "create-event-end",
      "update-event-ref",
      "update-event-title",
      "update-event-description",
      "update-event-start",
      "update-event-end",
      "gmail-draft-to",
      "gmail-draft-cc",
      "gmail-draft-bcc",
      "gmail-draft-subject",
      "gmail-draft-body",
      "gmail-send-draft-ref",
      "quo-text-to",
      "quo-text-content",
      "action-add",
      "action-draft-clear",
      "action-draft-list",
      "action-prepare",
      "approval-status",
      "approval-refresh",
      "approval-alert",
      "approval-locked",
      "approval-workspace",
      "approval-count",
      "approval-list",
      "approval-placeholder",
      "approval-detail",
      "approval-plan-title",
      "approval-plan-state",
      "approval-plan-id",
      "approval-file-ref",
      "approval-expires-at",
      "approval-digest",
      "approval-operations",
      "execution-gate-message",
      "approval-acknowledge",
      "approval-invalidate",
      "approval-execute",
      "receipt-status",
      "receipt-refresh",
      "receipt-alert",
      "receipt-locked",
      "receipt-workspace",
      "receipt-count",
      "receipt-list",
      "receipt-placeholder",
      "receipt-detail",
      "receipt-detail-heading",
      "receipt-detail-state",
      "receipt-detail-fields",
      "connections-status",
      "connections-refresh",
      "connections-sign-in",
      "connections-alert",
      "connections-locked",
      "connections-workspace",
      "connections-profile-name",
      "connections-profile-role",
      "jobnimbus-connection-status",
      "jobnimbus-connection-detail",
      "google-connection-status",
      "google-gmail-status",
      "google-calendar-status",
      "google-connect-action",
      "quo-connection-status",
      "quo-connection-detail",
      "quo-phone-form",
      "quo-phone",
      "quo-start",
      "quo-use-code",
      "quo-verify-form",
      "quo-code",
      "quo-verify",
      "quo-restart"
    ].forEach(function (id) {
      elements[id] = document.getElementById(id);
    });

    elements["retry-action"].addEventListener("click", loadPlatformState);
    elements["sign-out-action"].addEventListener("click", signOut);
    elements["assistant-form"].addEventListener("submit", submitAssistantTurn);
    elements["assistant-prompt"].addEventListener("keydown", function (event) {
      if (
        event.key === "Enter"
        && !event.shiftKey
        && !event.isComposing
      ) {
        event.preventDefault();
        elements["assistant-form"].requestSubmit();
      }
    });
    elements["assistant-review-action"].addEventListener(
      "click",
      reviewAssistantPlan
    );
    document.querySelectorAll("[data-assistant-starter]").forEach(function (button) {
      button.addEventListener("click", function () {
        const prompt = boundedString(
          button.getAttribute("data-assistant-starter"),
          2000
        ).trim();
        if (!prompt || state.assistantLoading) return;
        elements["assistant-prompt"].value = prompt;
        elements["assistant-form"].requestSubmit();
      });
    });
    elements["management-sweep-refresh"].addEventListener(
      "click",
      loadManagementSweep
    );
    elements["work-center-refresh"].addEventListener("click", function () {
      loadWorkCenter({ resetFile: true, offset: 0 });
    });
    elements["work-center-previous"].addEventListener("click", function () {
      const page = record(record(state.workCenter).page);
      const currentOffset = Number.isInteger(page.offset)
        ? page.offset
        : state.workCenterOffset;
      const offset = Math.max(
        0,
        currentOffset - WORK_CENTER_PAGE_SIZE
      );
      loadWorkCenter({ resetFile: true, offset: offset });
    });
    elements["work-center-next"].addEventListener("click", function () {
      const page = record(record(state.workCenter).page);
      if (page.hasMore !== true) return;
      const offset = Number(page.offset || 0) + WORK_CENTER_PAGE_SIZE;
      loadWorkCenter({ resetFile: true, offset: offset });
    });
    elements["file-refresh"].addEventListener("click", function () {
      if (state.selectedFileRef) loadFileReview(state.selectedFileRef);
    });
    elements["file-back"].addEventListener("click", closeFileReview);
    elements["action-type"].addEventListener("change", renderActionFields);
    elements["action-form"].addEventListener("submit", addDraftAction);
    elements["action-draft-clear"].addEventListener("click", function () {
      clearActionDraft("The memory-only draft was cleared.");
    });
    elements["action-prepare"].addEventListener("click", prepareActionPlan);
    elements["approval-refresh"].addEventListener("click", function () {
      loadActionPlans();
    });
    elements["approval-acknowledge"].addEventListener(
      "change",
      syncExecutionControls
    );
    elements["approval-invalidate"].addEventListener(
      "click",
      invalidateSelectedPlan
    );
    elements["approval-execute"].addEventListener(
      "click",
      executeSelectedPlan
    );
    elements["receipt-refresh"].addEventListener("click", function () {
      loadReceipts();
    });
    elements["connections-refresh"].addEventListener("click", loadConnections);
    elements["google-connect-action"].addEventListener(
      "click",
      startGoogleConnection
    );
    elements["quo-phone-form"].addEventListener("submit", startQuoConnection);
    elements["quo-verify-form"].addEventListener("submit", verifyQuoConnection);
    elements["quo-use-code"].addEventListener("click", showQuoCodeEntry);
    elements["quo-restart"].addEventListener("click", restartQuoConnection);
    window.addEventListener("online", handleNetworkChange);
    window.addEventListener("offline", handleNetworkChange);
    window.addEventListener("hashchange", syncActiveNavigation);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    document.querySelectorAll(".primary-nav .nav-item").forEach(function (link) {
      link.addEventListener("click", function () {
        setActiveNavigation(link);
      });
    });

    syncActiveNavigation();
    document.body.classList.add("console-ready");
    loadPlatformState();
    registerServiceWorker();
  }

  function consumeAuthCallbackOutcome() {
    let current;
    try {
      current = new URL(window.location.href);
    } catch {
      return "";
    }
    const outcomes = current.searchParams.getAll("auth");
    const outcome = outcomes.length === 1
      && AUTH_CALLBACK_OUTCOMES.has(outcomes[0])
      ? outcomes[0]
      : "";
    if (outcomes.length) {
      current.searchParams.delete("auth");
      const query = current.searchParams.toString();
      window.history.replaceState(
        null,
        "",
        current.pathname + (query ? "?" + query : "") + current.hash
      );
    }
    return outcome;
  }

  function renderAuthCallbackOutcome() {
    const outcome = state.authCallbackOutcome;
    state.authCallbackOutcome = "";
    const message = authCallbackMessage(
      outcome,
      hasBrowserAuthority()
    );
    elements["home-auth-alert"].hidden = !message;
    if (!message) return;
    notice(
      elements["home-auth-alert"],
      message.text,
      message.tone
    );
  }

  function authCallbackMessage(outcome, authenticated) {
    if (!outcome || authenticated) return null;
    if (outcome === "cancelled") {
      return {
        text: "Sign-in was canceled. Try again when you are ready.",
        tone: "warn"
      };
    }
    if (outcome === "access_denied") {
      return {
        text: "HCN could not sign you in. Choose the Google account tied to your active JobNimbus employee profile. If that is the right account, ask an HCN manager to check the email on your JobNimbus user.",
        tone: "bad"
      };
    }
    if (outcome === "invalid_request") {
      return {
        text: "That sign-in attempt expired or could not be verified. Start sign-in again.",
        tone: "warn"
      };
    }
    if (outcome === "provider_error") {
      return {
        text: "Google sign-in did not finish. Try again.",
        tone: "warn"
      };
    }
    if (outcome === "temporarily_unavailable") {
      return {
        text: "HCN sign-in is temporarily unavailable. Try again in a moment.",
        tone: "warn"
      };
    }
    return null;
  }

  function consumeGoogleCallbackOutcome() {
    let current;
    try {
      current = new URL(window.location.href);
    } catch {
      return "";
    }
    const outcomes = current.searchParams.getAll("google");
    const outcome = outcomes.length === 1
      && GOOGLE_CALLBACK_OUTCOMES.has(outcomes[0])
      ? outcomes[0]
      : "";
    if (outcomes.length) {
      current.searchParams.delete("google");
      const query = current.searchParams.toString();
      window.history.replaceState(
        null,
        "",
        current.pathname + (query ? "?" + query : "") + current.hash
      );
    }
    return outcome;
  }

  function syncCapabilityAwareConsole() {
    const capabilities = new Set(sessionCapabilities());
    const authorized = hasBrowserAuthority();
    const allowedHashes = new Set(
      Array.from(document.querySelectorAll(".primary-nav .nav-item"))
        .map(function (link) {
          return link.getAttribute("href");
        })
        .filter(function (href) {
          return /^#[a-z0-9-]+$/.test(String(href || ""));
        })
    );
    document.querySelectorAll("[data-hcn-capability]").forEach(function (element) {
      const capability = boundedString(
        element.getAttribute("data-hcn-capability"),
        160
      );
      element.hidden = !authorized || !capabilities.has(capability);
    });

    let preferredHash = window.location.hash;
    if (state.googleCallbackOutcome && hasConnectorReadAuthority()) {
      preferredHash = "#connections";
    } else if (!preferredHash) {
      preferredHash = "#overview";
    }

    if (!allowedHashes.has(preferredHash)) preferredHash = "#overview";
    const preferredSection = document.getElementById(preferredHash.slice(1));
    if (!preferredSection || preferredSection.hidden) {
      preferredHash = hasWorkCenterAuthority() ? "#work-center" : "#overview";
    }
    if (window.location.hash !== preferredHash) {
      window.history.replaceState(null, "", preferredHash);
      const target = document.getElementById(preferredHash.slice(1));
      if (target) target.scrollIntoView({ block: "start" });
    }
    syncActiveNavigation();
  }

  function setActiveNavigation(activeLink) {
    document.querySelectorAll(".primary-nav .nav-item").forEach(function (link) {
      const active = link === activeLink && !link.hidden;
      link.classList.toggle("is-active", active);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
  }

  function syncActiveNavigation() {
    const hash = window.location.hash || "#overview";
    const links = Array.from(
      document.querySelectorAll(".primary-nav .nav-item")
    ).filter(function (link) {
      return !link.hidden;
    });
    const exact = links.find(function (link) {
      return link.getAttribute("href") === hash;
    });
    const activeLink = exact || links[0] || null;
    setActiveNavigation(activeLink);
    const activeHash = activeLink
      ? activeLink.getAttribute("href")
      : "#overview";
    document.querySelectorAll(".console-view").forEach(function (section) {
      section.classList.toggle(
        "is-current-view",
        "#" + section.id === activeHash && !section.hidden
      );
    });
  }

  function syncHomeGuidance() {
    const authenticated = hasBrowserAuthority();
    const canWork = hasWorkCenterAuthority();
    const canSweep = hasManagementSweepAuthority();
    const canConnect = hasConnectorReadAuthority();

    if (!navigator.onLine) {
      setText(elements["home-next-action"], "Reconnect to keep working");
      setText(
        elements["home-next-detail"],
        "Your file information was cleared when the connection went offline."
      );
      badge(elements["home-work-status"], "Offline", "bad");
      badge(elements["home-sweep-status"], "Offline", "bad");
      badge(elements["home-connections-status"], "Offline", "bad");
      return;
    }

    if (!authenticated) {
      setText(elements["home-next-action"], "Sign in to start");
      setText(
        elements["home-next-detail"],
        "Use your HCN account. Your access decides what appears next."
      );
      badge(elements["home-work-status"], "Sign in first", "neutral");
      badge(elements["home-sweep-status"], "Sign in first", "neutral");
      badge(elements["home-connections-status"], "Sign in first", "neutral");
      return;
    }

    if (!canWork) {
      badge(elements["home-work-status"], "Not available", "neutral");
    } else if (state.workCenterLoading) {
      badge(elements["home-work-status"], "Loading files", "neutral");
    } else if (state.workCenter) {
      const total = Number(record(state.workCenter.page).total || 0);
      badge(
        elements["home-work-status"],
        total + " assigned",
        total ? "good" : "neutral"
      );
    } else {
      badge(elements["home-work-status"], "Ready", "good");
    }

    if (!canSweep) {
      badge(elements["home-sweep-status"], "Not available", "neutral");
    } else if (state.managementSweepLoading) {
      badge(elements["home-sweep-status"], "Running", "neutral");
    } else if (state.managementSweep) {
      badge(elements["home-sweep-status"], "Report ready", "good");
    } else if (managementSweepRuntimeStatus() === "configured") {
      badge(elements["home-sweep-status"], "Ready to run", "good");
    } else {
      badge(elements["home-sweep-status"], "Setup needed", "warn");
    }

    let connectionsNeedSetup = false;
    if (!canConnect) {
      badge(elements["home-connections-status"], "Not available", "neutral");
    } else if (state.connectionsLoading) {
      badge(elements["home-connections-status"], "Checking", "neutral");
    } else if (state.connections) {
      const connections = record(state.connections);
      const connectedCount = [
        record(connections.jobNimbus).status,
        record(connections.google).status,
        record(connections.quo).status
      ].filter(function (status) {
        return status === "connected";
      }).length;
      connectionsNeedSetup = connectedCount < 3;
      badge(
        elements["home-connections-status"],
        connectedCount === 3 ? "All connected" : connectedCount + " of 3 connected",
        connectedCount === 3 ? "good" : "warn"
      );
    } else {
      badge(elements["home-connections-status"], "Ready to check", "good");
    }

    if (state.connectionsLoading) {
      setText(elements["home-next-action"], "Checking your connections");
      setText(
        elements["home-next-detail"],
        "HCN is verifying the work accounts available to you."
      );
      return;
    }
    if (connectionsNeedSetup) {
      setText(elements["home-next-action"], "Finish your connections");
      setText(
        elements["home-next-detail"],
        "Open Connections to see which work account needs attention."
      );
      return;
    }
    if (state.workCenterLoading) {
      setText(elements["home-next-action"], "Loading your files");
      setText(
        elements["home-next-detail"],
        "HCN is checking your current assigned JobNimbus queue."
      );
      return;
    }
    if (canWork) {
      const total = state.workCenter
        ? Number(record(state.workCenter.page).total || 0)
        : 0;
      setText(
        elements["home-next-action"],
        total ? "Open your assigned files" : "Open Work My Files"
      );
      setText(
        elements["home-next-detail"],
        total
          ? total + " file" + (total === 1 ? " is" : "s are")
            + " ready for review."
          : "Start with your current assigned-file queue."
      );
      return;
    }
    if (canSweep) {
      setText(elements["home-next-action"], "Run the Company Sweep");
      setText(
        elements["home-next-detail"],
        "Find the company files with the longest activity gaps."
      );
      return;
    }
    setText(elements["home-next-action"], "Your account is signed in");
    setText(
      elements["home-next-detail"],
      "Ask an HCN manager if you expected another work option here."
    );
  }

  function syncAssistantAccess() {
    const signedIn = hasBrowserAuthority();
    const authorized = hasAssistantAuthority();
    syncAssistantControls();
    if (state.assistantLoading) {
      notice(
        elements["assistant-alert"],
        "Thresher is working on your request.",
        "neutral"
      );
      return;
    }
    if (!navigator.onLine) {
      notice(
        elements["assistant-alert"],
        "Reconnect before asking Thresher to review live work.",
        "warn"
      );
      return;
    }
    if (!signedIn) {
      notice(
        elements["assistant-alert"],
        "Sign in to ask Thresher for help.",
        "neutral"
      );
      return;
    }
    if (!authorized) {
      notice(
        elements["assistant-alert"],
        "Your HCN account is signed in, but Ask Thresher is not enabled for this role.",
        "warn"
      );
      return;
    }
    const runtimeStatus = assistantRuntimeStatus();
    if (!["configured", "direct_only"].includes(runtimeStatus)) {
      notice(
        elements["assistant-alert"],
        runtimeStatus === "unconfigured"
          ? "Ask Thresher setup is not finished yet."
          : "Ask Thresher readiness could not be verified.",
        "warn"
      );
      return;
    }
    if (runtimeStatus === "direct_only") {
      notice(
        elements["assistant-alert"],
        "Direct JobNimbus lookups are ready. Deeper AI review is not connected yet.",
        "warn"
      );
      return;
    }
    notice(
      elements["assistant-alert"],
      "Ready. Ask about a file, communication, follow-up, claim, or next step.",
      "good"
    );
  }

  function syncAssistantControls() {
    const runtimeStatus = assistantRuntimeStatus();
    const available = (
      navigator.onLine
      && hasAssistantAuthority()
      && ["configured", "direct_only"].includes(runtimeStatus)
      && !state.assistantLoading
    );
    elements["assistant-prompt"].disabled = (
      !available || runtimeStatus === "direct_only"
    );
    elements["assistant-send"].disabled = (
      !available || runtimeStatus === "direct_only"
    );
    document.querySelectorAll("[data-assistant-starter]").forEach(function (button) {
      button.disabled = (
        !available
        || (
          runtimeStatus === "direct_only"
          && button.dataset.assistantDirect !== "true"
        )
      );
    });
    elements["assistant-transcript"].setAttribute(
      "aria-busy",
      state.assistantLoading ? "true" : "false"
    );
    elements["assistant-review-action"].disabled = (
      state.assistantLoading
      || !state.assistantPlanId
      || !hasActionReadAuthority()
    );
    if (runtimeStatus === "direct_only") {
      elements["assistant-mode-auto"].checked = true;
      elements["assistant-mode-deep"].checked = false;
    }
    elements["assistant-mode-auto"].disabled = !available;
    elements["assistant-mode-deep"].disabled = (
      !available || runtimeStatus !== "configured"
    );
  }

  async function submitAssistantTurn(event) {
    event.preventDefault();
    if (state.assistantLoading) return;
    if (
      !navigator.onLine
      || !hasAssistantAuthority()
      || !["configured", "direct_only"].includes(
        assistantRuntimeStatus()
      )
    ) {
      syncAssistantAccess();
      return;
    }

    const prompt = boundedString(
      elements["assistant-prompt"].value,
      2000
    ).trim();
    const mode = selectedAssistantMode();
    if (!prompt) {
      notice(
        elements["assistant-alert"],
        "Tell Thresher what you need before sending.",
        "warn"
      );
      elements["assistant-prompt"].focus();
      return;
    }

    if (state.assistantController) state.assistantController.abort();
    const controller = new AbortController();
    state.assistantController = controller;
    state.assistantLoading = true;
    state.assistantPlanId = null;
    elements["assistant-review-action"].hidden = true;
    elements["assistant-prompt"].value = "";
    appendAssistantMessage("user", prompt);
    const pending = appendAssistantMessage(
      "assistant",
      "Working on that…",
      { busy: true }
    );
    syncAssistantAccess();

    try {
      const response = await postOperationalJson(
        ENDPOINTS.assistantTurns,
        { prompt: prompt, mode: mode },
        controller.signal,
        ASSISTANT_TURN_CAPABILITY
      );
      if (controller.signal.aborted) return;
      const turn = normalizeAssistantTurnResponse(response);
      pending.remove();
      appendAssistantMessage("assistant", turn.message);
      if (turn.planId) {
        state.assistantPlanId = turn.planId;
        state.assistantPreparedPlanCount += 1;
        elements["assistant-review-action"].hidden = false;
      }
      renderAssistantPilot(turn);
      notice(
        elements["assistant-alert"],
        turn.planId
          ? "Thresher prepared an action. Review every detail before approval."
          : "Thresher finished the review.",
        "good"
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      pending.remove();
      if (isAuthorizationStatus(error)) {
        handleOperationalAuthLoss();
        return;
      }
      appendAssistantMessage(
        "assistant",
        "I couldn’t complete that review. " + assistantErrorMessage(error)
      );
      notice(
        elements["assistant-alert"],
        assistantErrorMessage(error),
        "bad"
      );
    } finally {
      if (state.assistantController === controller) {
        state.assistantController = null;
        state.assistantLoading = false;
        syncAssistantControls();
      }
    }
    elements["assistant-prompt"].focus();
  }

  function normalizeAssistantTurnResponse(value) {
    if (!isRecord(value)) throw new Error("Invalid assistant response");
    const allowed = new Set([
      "schema",
      "generatedAt",
      "ephemeral",
      "cachePolicy",
      "authority",
      "message",
      "plan",
      "sources",
      "routing"
    ]);
    const authority = record(value.authority);
    const allowedAuthority = new Set([
      "fileScope",
      "liveSourcesWin",
      "canRead",
      "canPrepareActionPlans",
      "canExecuteActions",
      "exactHumanApprovalRequired"
    ]);
    const keys = Object.keys(value);
    const authorityKeys = Object.keys(authority);
    const routing = normalizeAssistantRouting(value.routing);
    const sources = normalizeAssistantSources(value.sources);
    if (
      keys.length !== allowed.size
      || keys.some(function (key) {
        return !allowed.has(key);
      })
      || authorityKeys.length !== allowedAuthority.size
      || authorityKeys.some(function (key) {
        return !allowedAuthority.has(key);
      })
      || value.schema !== "hcn.console.assistant-turn.v2"
      || !validIsoInstant(value.generatedAt)
      || value.ephemeral !== true
      || value.cachePolicy !== "no_store"
      || authority.fileScope !== "signed_in_employee_assignments_only"
      || authority.liveSourcesWin !== true
      || authority.canRead !== true
      || authority.canPrepareActionPlans !== true
      || authority.canExecuteActions !== false
      || authority.exactHumanApprovalRequired !== true
      || typeof value.message !== "string"
      || value.message.length > 16000
      || !(value.plan === null || isRecord(value.plan))
    ) {
      throw new Error("Invalid assistant response");
    }

    const message = boundedString(value.message, 16000).trim();
    if (!message || message !== value.message.trim()) {
      throw new Error("Invalid assistant response");
    }

    let planId = "";
    if (isRecord(value.plan)) {
      planId = normalizeActionPlan(value.plan, true).planId;
    }
    return {
      message: message,
      planId: planId,
      sourceCount: sources.filter(function (source) {
        return source.key !== "action_plan";
      }).length,
      routing: routing
    };
  }

  function normalizeAssistantRouting(value) {
    if (!isRecord(value)) throw new Error("Invalid assistant response");
    const allowed = new Set([
      "route",
      "profileId",
      "reasonCodes",
      "modelUsed"
    ]);
    const keys = Object.keys(value);
    const profileId = boundedString(value.profileId, 120);
    const routeContract = ASSISTANT_ROUTE_PROFILES[value.route];
    const allowedReasonCodes = ASSISTANT_ROUTE_REASON_CODES[value.route];
    if (
      keys.length !== allowed.size
      || keys.some(function (key) {
        return !allowed.has(key);
      })
      || !ASSISTANT_ROUTES.has(value.route)
      || !profileId
      || profileId !== String(value.profileId).trim()
      || !routeContract
      || profileId !== routeContract.profileId
      || !Array.isArray(allowedReasonCodes)
      || !Array.isArray(value.reasonCodes)
      || value.reasonCodes.length === 0
      || value.reasonCodes.length > 12
      || value.modelUsed !== routeContract.modelUsed
    ) {
      throw new Error("Invalid assistant response");
    }
    const reasonCodes = value.reasonCodes.map(function (reason) {
      if (
        typeof reason !== "string"
        || reason.length === 0
        || reason.length > 80
        || reason !== reason.trim()
        || !allowedReasonCodes.includes(reason)
      ) {
        throw new Error("Invalid assistant response");
      }
      return reason;
    });
    if (new Set(reasonCodes).size !== reasonCodes.length) {
      throw new Error("Invalid assistant response");
    }
    return {
      route: value.route,
      profileId: profileId,
      reasonCodes: reasonCodes,
      modelUsed: value.modelUsed
    };
  }

  function normalizeAssistantSources(value) {
    if (!Array.isArray(value) || value.length > 50) {
      throw new Error("Invalid assistant response");
    }
    const allowed = new Set(["key", "label", "status", "checkedAt"]);
    const seen = new Set();
    return value.map(function (source) {
      if (!isRecord(source)) {
        throw new Error("Invalid assistant response");
      }
      const keys = Object.keys(source);
      const key = boundedString(source.key, 32);
      const label = boundedString(source.label, 80);
      const status = boundedString(source.status, 32);
      if (
        keys.length !== allowed.size
        || keys.some(function (field) {
          return !allowed.has(field);
        })
        || !ASSISTANT_SOURCE_KEYS.has(key)
        || seen.has(key)
        || !label
        || label !== String(source.label).trim()
        || !ASSISTANT_SOURCE_STATUSES.has(status)
        || !validIsoInstant(source.checkedAt)
      ) {
        throw new Error("Invalid assistant response");
      }
      seen.add(key);
      return { key: key, label: label, status: status };
    });
  }

  function selectedAssistantMode() {
    const selected = document.querySelector(
      'input[name="assistant-mode"]:checked'
    );
    const mode = boundedString(selected && selected.value, 12);
    return ASSISTANT_MODES.has(mode) ? mode : "auto";
  }

  function renderAssistantPilot(turn) {
    const routeLabels = {
      deterministic: "Direct lookup",
      standard: "Standard review",
      deep: "Deep review",
      codex_escalation: "Needs operator review"
    };
    setText(
      elements["assistant-pilot-route"],
      routeLabels[turn.routing.route] || "Unavailable"
    );
    setText(elements["assistant-pilot-sources"], String(turn.sourceCount));
    setText(
      elements["assistant-pilot-plans"],
      String(state.assistantPreparedPlanCount)
    );
  }

  function appendAssistantMessage(speaker, message, options) {
    const article = document.createElement("article");
    const label = document.createElement("span");
    const paragraph = document.createElement("p");
    const normalizedSpeaker = speaker === "user" ? "user" : "assistant";
    article.className = "assistant-message";
    article.dataset.speaker = normalizedSpeaker;
    if (options?.busy === true) article.dataset.busy = "true";
    label.className = "assistant-speaker";
    setText(label, normalizedSpeaker === "user" ? "You" : "Thresher");
    setText(paragraph, boundedString(message, 16000));
    article.append(label, paragraph);
    elements["assistant-transcript"].append(article);
    elements["assistant-transcript"].scrollTop =
      elements["assistant-transcript"].scrollHeight;
    return article;
  }

  function clearAssistantData() {
    if (state.assistantController) state.assistantController.abort();
    state.assistantController = null;
    state.assistantLoading = false;
    state.assistantPlanId = null;
    state.assistantPreparedPlanCount = 0;
    elements["assistant-prompt"].value = "";
    elements["assistant-mode-auto"].checked = true;
    elements["assistant-mode-deep"].checked = false;
    elements["assistant-review-action"].hidden = true;
    setText(elements["assistant-pilot-route"], "Not run yet");
    setText(elements["assistant-pilot-sources"], "0");
    setText(elements["assistant-pilot-plans"], "0");
    elements["assistant-transcript"].replaceChildren();
    appendAssistantMessage(
      "assistant",
      "What do you need help with?"
    );
    syncAssistantControls();
  }

  async function reviewAssistantPlan() {
    const planId = state.assistantPlanId;
    if (!PLAN_ID.test(String(planId || "")) || !hasActionReadAuthority()) {
      notice(
        elements["assistant-alert"],
        "That proposed action is not available for review in this session.",
        "warn"
      );
      return;
    }
    window.location.hash = "#approvals";
    syncActiveNavigation();
    const approvals = document.getElementById("approvals");
    if (approvals) approvals.scrollIntoView({ block: "start" });
    await loadActionPlans({ selectPlanId: planId });
  }

  function assistantErrorMessage(error) {
    if (!navigator.onLine) {
      return "The connection went offline. Try again after reconnecting.";
    }
    const status = statusOf(error);
    if (status === 429) {
      return "Thresher is busy. Wait a moment, then try again.";
    }
    if (status === 502 || status === 503) {
      return "Thresher or a live work source is temporarily unavailable.";
    }
    return "No result or proposed action was accepted. Please try again.";
  }

  async function loadPlatformState() {
    if (state.loading) return;
    cancelSessionExpiryTimer();
    cancelManagementSweepExpiryTimer();
    state.loading = true;
    state.metaError = null;
    state.sessionError = null;
    clearOperationalData("Rechecking the signed-in session before loading client records.");
    setLoadingView();

    const results = await Promise.allSettled([
      fetchJson(ENDPOINTS.meta),
      fetchJson(ENDPOINTS.session)
    ]);

    if (results[0].status === "fulfilled") {
      state.meta = results[0].value;
      renderMeta(state.meta);
    } else {
      state.meta = null;
      state.metaError = results[0].reason;
      renderMetaError(state.metaError);
    }

    if (results[1].status === "fulfilled") {
      state.session = results[1].value;
      renderSession(state.session);
    } else {
      state.session = null;
      state.sessionError = results[1].reason;
      renderSessionError(state.sessionError);
    }

    renderAuthCallbackOutcome();
    state.loading = false;
    elements["retry-action"].disabled = false;
    renderOverallState();
    syncOperationalAccess();
  }

  async function fetchJson(url) {
    const response = await fetch(url, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      const error = new Error("Request failed");
      error.status = response.status;
      throw error;
    }
    if (url === ENDPOINTS.session) {
      applySessionDeadlinesFromResponse(response);
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new Error("Unexpected response format");
    }

    const data = await response.json();
    if (!isRecord(data)) throw new Error("Invalid response");
    return data;
  }

  async function postOperationalJson(url, body, signal, requiredCapability) {
    if (
      !hasBrowserAuthority()
      || (
        requiredCapability
        && !sessionCapabilities().includes(requiredCapability)
      )
    ) {
      const error = new Error("Operational authority is unavailable");
      error.status = 403;
      throw error;
    }

    const csrfToken = stringValue(
      record(record(state.session).browserSession).csrfToken
    );
    if (!csrfToken) {
      const error = new Error("Session verification is unavailable");
      error.status = 401;
      throw error;
    }

    const response = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal: signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-HCN-CSRF": csrfToken
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const error = new Error("Operational request failed");
      error.status = response.status;
      throw error;
    }
    applySessionDeadlinesFromResponse(response);

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new Error("Unexpected response format");
    }

    const data = await response.json();
    if (!isRecord(data)) throw new Error("Invalid response");
    return data;
  }

  function applySessionDeadlinesFromResponse(response) {
    const idleExpiresAt = response.headers.get(SESSION_IDLE_HEADER);
    const expiresAt = response.headers.get(SESSION_ABSOLUTE_HEADER);
    if (!scheduleSessionExpiry(idleExpiresAt, expiresAt)) {
      expireBrowserSession(
        "The HCN session expiry could not be verified. Client data was cleared."
      );
      const error = new Error("Session expiry verification failed");
      error.status = 401;
      throw error;
    }
    const session = record(state.session);
    const browserSession = record(session.browserSession);
    if (session.authenticated === true && stringValue(browserSession.csrfToken)) {
      state.session = {
        ...session,
        browserSession: {
          ...browserSession,
          idleExpiresAt: idleExpiresAt,
          expiresAt: expiresAt
        }
      };
    }
  }

  function scheduleSessionExpiry(idleExpiresAt, expiresAt) {
    const idleDeadline = Date.parse(String(idleExpiresAt || ""));
    const absoluteDeadline = Date.parse(String(expiresAt || ""));
    if (
      !Number.isFinite(idleDeadline)
      || !Number.isFinite(absoluteDeadline)
      || idleDeadline <= 0
      || absoluteDeadline <= 0
    ) {
      cancelSessionExpiryTimer();
      return false;
    }
    const deadline = Math.min(idleDeadline, absoluteDeadline);
    cancelSessionExpiryTimer();
    state.sessionDeadlineMs = deadline;
    if (deadline <= Date.now()) return false;
    state.sessionExpiryTimer = window.setTimeout(
      function () {
        expireBrowserSession(
          "The HCN session expired. Client data was cleared from this page."
        );
      },
      Math.min(MAX_TIMER_DELAY_MS, Math.max(1, deadline - Date.now()))
    );
    return true;
  }

  function scheduleSessionExpiryFromSession(session) {
    const browserSession = record(record(session).browserSession);
    return scheduleSessionExpiry(
      browserSession.idleExpiresAt,
      browserSession.expiresAt
    );
  }

  function cancelSessionExpiryTimer() {
    if (state.sessionExpiryTimer !== null) {
      window.clearTimeout(state.sessionExpiryTimer);
    }
    state.sessionExpiryTimer = null;
    state.sessionDeadlineMs = 0;
  }

  function enforceSessionDeadline() {
    if (document.hidden || !state.sessionDeadlineMs) return;
    if (Date.now() < state.sessionDeadlineMs) return;
    expireBrowserSession(
      "The HCN session expired. Client data was cleared from this page."
    );
  }

  function expireBrowserSession(message) {
    cancelSessionExpiryTimer();
    clearOperationalData(message);
    state.session = null;
    state.sessionError = { status: 401 };
    renderSignedOut(
      "Sign in with your HCN account to verify operating authority again."
    );
    renderOperationsLocked(
      "Session expired",
      "Sign in with your HCN account to load fresh assigned files."
    );
    renderOverallState();
  }

  function setLoadingView() {
    elements["retry-action"].disabled = true;
    elements["sign-in-action"].hidden = true;
    elements["sign-out-action"].hidden = true;
    elements["work-center-sign-in"].hidden = true;
    elements["connections-sign-in"].hidden = true;
    setConnection("pending", "Checking");
    setText(elements["load-message"], "Checking fresh platform and session metadata…");
  }

  function renderMeta(meta) {
    const runtime = record(meta.runtime);
    renderConnectors(record(runtime.connectors));
    renderGates(record(runtime.gates), record(runtime.configurationDrift));
    renderBoundaries();
    renderBuild(record(meta.build));

    const generatedAt = readableTime(meta.generatedAt);
    setText(
      elements["freshness-text"],
      generatedAt
        ? "Platform metadata checked " + generatedAt + "."
        : "Platform metadata received; timestamp unavailable."
    );
    syncExecutionControls();
  }

  function renderMetaError(error) {
    setText(elements["connector-metric"], "Unavailable");
    setText(elements["connector-metric-detail"], "Bridge metadata not received");
    setText(elements["gate-metric"], "Unavailable");
    setText(elements["gate-metric-detail"], "Runtime gates not received");
    setText(elements["build-metric"], "Unverified");
    setText(elements["build-metric-detail"], "Build metadata not received");
    badge(elements["connectors-card-status"], "Unavailable", "bad");
    badge(elements["controls-card-status"], "Unavailable", "bad");
    badge(elements["build-card-status"], "Unverified", "bad");
    renderEmpty(elements["connector-list"], "Connected-system status is unavailable.");
    renderEmpty(elements["gate-list"], "Runtime gate status is unavailable.");
    renderEmpty(elements["boundary-list"], "HCN data protection could not be verified.");
    renderBuildPlaceholder("Metadata unavailable");
    setText(
      elements["freshness-text"],
      statusOf(error) ? "Platform check returned status " + statusOf(error) + "." : "Platform check failed."
    );
    syncExecutionControls();
  }

  function renderConnectors(connectors) {
    const entries = knownEntries(connectors, CONNECTOR_LABELS);
    const configured = entries.filter(function (entry) {
      return entry.value === "configured";
    }).length;

    setText(elements["connector-metric"], configured + " / " + entries.length);
    setText(elements["connector-metric-detail"], "Configured now");
    badge(
      elements["connectors-card-status"],
      configured === entries.length ? "All configured" : configured + " configured",
      configured === entries.length ? "good" : "neutral"
    );
    renderStatusItems(elements["connector-list"], entries, connectorTone);
  }

  function renderGates(gates, drift) {
    const entries = knownEntries(gates, GATE_LABELS);
    const enabled = entries.filter(function (entry) {
      return entry.value === "enabled";
    }).length;

    setText(elements["gate-metric"], enabled + " enabled");
    setText(elements["gate-metric-detail"], entries.length + " effect gates reported");
    badge(elements["controls-card-status"], entries.length + " reported", "neutral");
    renderStatusItems(elements["gate-list"], entries, gateTone);

    const driftStatus = stringValue(drift.status);
    if (driftStatus === "aligned") {
      notice(
        elements["drift-message"],
        "Release-critical effect gates match the checked-in defaults.",
        "good"
      );
    } else if (driftStatus === "detected") {
      const differences = Array.isArray(drift.differences) ? drift.differences.length : 0;
      notice(
        elements["drift-message"],
        "Runtime configuration drift detected across " + differences + " release-critical gate" +
          (differences === 1 ? "." : "s."),
        "warn"
      );
    } else {
      notice(
        elements["drift-message"],
        "Some release-critical gate values could not be compared.",
        "neutral"
      );
    }
  }

  function renderBoundaries() {
    const item = document.createElement("div");
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    const status = document.createElement("span");
    const mark = document.createElement("i");
    item.className = "boundary-item";
    setText(title, "HCN data protection");
    setText(
      status,
      "Active · your account controls what you can see and propose"
    );
    mark.className = "boundary-state";
    mark.dataset.tone = "good";
    mark.setAttribute("aria-hidden", "true");
    copy.append(title, status);
    item.append(copy, mark);
    elements["boundary-list"].replaceChildren(item);
  }

  function renderBuild(build) {
    const attested = build.attested === true;
    const sourceCommit = stringValue(build.sourceCommit);
    const runtime = record(build.runtime);
    const runtimeText = [
      stringValue(runtime.name),
      stringValue(runtime.version),
      stringValue(runtime.platform),
      stringValue(runtime.architecture)
    ].filter(Boolean).join(" · ");

    setText(elements["build-metric"], attested ? "Attested" : "Unverified");
    setText(
      elements["build-metric-detail"],
      sourceCommit ? "Commit " + sourceCommit.slice(0, 12) : "No source revision"
    );
    badge(elements["build-card-status"], attested ? "Provider attested" : "Not attested", attested ? "good" : "bad");

    const rows = [
      ["Service", stringValue(build.service) || "Unknown"],
      ["Source", sourceCommit ? sourceCommit.slice(0, 12) : "Unavailable"],
      ["Runtime", runtimeText || "Unknown"],
      ["API", stringValue(build.apiVersion) || "Unknown"]
    ];
    renderDetails(rows);
  }

  function renderBuildPlaceholder(message) {
    renderDetails([
      ["Service", message],
      ["Source", "Unavailable"],
      ["Runtime", "Unavailable"]
    ]);
  }

  function renderDetails(rows) {
    const fragment = document.createDocumentFragment();
    rows.forEach(function (row) {
      const wrapper = document.createElement("div");
      const term = document.createElement("dt");
      const detail = document.createElement("dd");
      setText(term, row[0]);
      setText(detail, row[1]);
      wrapper.append(term, detail);
      fragment.append(wrapper);
    });
    elements["build-details"].replaceChildren(fragment);
  }

  function renderSession(session) {
    const identity = record(session.identity);
    const profile = record(session.profile);
    const capabilities = Array.isArray(session.authorizedCapabilities)
      ? session.authorizedCapabilities.filter(function (value) {
          return typeof value === "string" && value.length <= 160;
        })
      : [];
    const authenticated = session.authenticated === true &&
      identity.authentication === "authenticated";

    if (!authenticated) {
      renderSignedOut("The session did not provide an authenticated operating identity.");
      return;
    }
    if (!scheduleSessionExpiryFromSession(session)) {
      expireBrowserSession(
        "The HCN session expiry could not be verified. Client data was cleared."
      );
      return;
    }

    const identityType = stringValue(identity.type);
    const role = stringValue(identity.role) || "authorized operator";
    const scope = stringValue(identity.jobNimbusScope) || "defined";
    const identityLabel = identityType === "hcn_browser_session"
      ? "HCN browser session"
      : identityType === "google_oauth"
        ? "Google session"
        : "Codex operator";

    elements["sign-in-action"].hidden = true;
    elements["sign-out-action"].hidden = false;
    elements["work-center-sign-in"].hidden = true;
    elements["connections-sign-in"].hidden = true;
    setText(
      elements["connections-profile-name"],
      boundedString(profile.displayName, 100) || "Signed-in employee"
    );
    setText(
      elements["connections-profile-role"],
      humanize(boundedString(profile.role, 64) || role)
    );
    badge(elements["identity-badge"], identityLabel, "good");
    setText(elements["capability-metric"], String(capabilities.length));
    setText(
      elements["capability-metric-detail"],
      scope === "none"
        ? humanize(role) + " · foundation only"
        : humanize(role) + " · " + humanize(scope) + " scope"
    );
    setText(
      elements["capability-summary"],
      "Signed in as " + humanize(role) + (
        scope === "none"
          ? " for the foundation console. "
          : " with " + humanize(scope) + " JobNimbus scope. "
      ) + capabilities.length +
        " route-level capabilit" + (capabilities.length === 1 ? "y is" : "ies are") +
        " authorized; runtime gates still control effects."
    );
    renderCapabilityGroups(capabilities);
  }

  function renderSessionError(error) {
    const status = statusOf(error);
    if (status === 401 || status === 403) {
      renderSignedOut("Sign in with your HCN account to see your exact operating scope.");
      return;
    }

    elements["sign-in-action"].hidden = true;
    elements["sign-out-action"].hidden = true;
    elements["work-center-sign-in"].hidden = true;
    elements["connections-sign-in"].hidden = true;
    badge(elements["identity-badge"], "Unavailable", "bad");
    setText(elements["capability-metric"], "Unavailable");
    setText(elements["capability-metric-detail"], "Session check failed");
    setText(
      elements["capability-summary"],
      "Your operating scope could not be checked. No authority is assumed."
    );
    elements["capability-groups"].replaceChildren();
  }

  function renderSignedOut(message) {
    cancelSessionExpiryTimer();
    elements["sign-in-action"].hidden = false;
    elements["sign-out-action"].hidden = true;
    elements["work-center-sign-in"].hidden = false;
    elements["connections-sign-in"].hidden = false;
    renderManagementSweepLocked("Sign in required", message);
    badge(elements["identity-badge"], "Sign in required", "neutral");
    setText(elements["capability-metric"], "Sign in");
    setText(elements["capability-metric-detail"], "Authority not assumed");
    setText(elements["capability-summary"], message);
    elements["capability-groups"].replaceChildren();
    syncCapabilityAwareConsole();
    syncAssistantAccess();
  }

  async function signOut() {
    const browserSession = record(record(state.session).browserSession);
    const csrfToken = stringValue(browserSession.csrfToken);
    if (!csrfToken) {
      clearOperationalData("The browser session could not be verified.");
      await loadPlatformState();
      return;
    }

    cancelSessionExpiryTimer();
    cancelManagementSweepExpiryTimer();
    clearOperationalData("Signing out and clearing client records from this page.");
    elements["sign-out-action"].disabled = true;
    try {
      const response = await fetch(ENDPOINTS.logout, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-HCN-CSRF": csrfToken
        },
        body: "{}"
      });
      if (!response.ok) throw new Error("Sign out failed");
      state.session = null;
      state.sessionError = { status: 401 };
      renderSignedOut("You are signed out. No operating authority is assumed.");
      renderOperationsLocked(
        "Signed out",
        "Sign in with your HCN account to load fresh assigned files."
      );
      renderOverallState();
    } catch {
      setText(
        elements["load-message"],
        "Sign out could not be confirmed. Check the session again before continuing."
      );
    } finally {
      elements["sign-out-action"].disabled = false;
    }
  }

  function sessionCapabilities() {
    const values = record(state.session).authorizedCapabilities;
    return Array.isArray(values)
      ? values.filter(function (value) {
          return typeof value === "string" && value.length <= 160;
        })
      : [];
  }

  function hasBrowserAuthority() {
    if (
      state.sessionDeadlineMs
      && Date.now() >= state.sessionDeadlineMs
    ) {
      expireBrowserSession(
        "The HCN session expired. Client data was cleared from this page."
      );
      return false;
    }
    const session = record(state.session);
    const identity = record(session.identity);
    return (
      session.authenticated === true &&
      identity.authentication === "authenticated" &&
      identity.type === "hcn_browser_session"
    );
  }

  function hasWorkCenterAuthority() {
    return (
      hasBrowserAuthority()
      && sessionCapabilities().includes(WORK_CENTER_CAPABILITY)
    );
  }

  function hasAssistantAuthority() {
    return (
      hasBrowserAuthority()
      && sessionCapabilities().includes(ASSISTANT_TURN_CAPABILITY)
    );
  }

  function assistantRuntimeStatus() {
    const runtime = record(record(state.session).runtime);
    const assistant = record(runtime.assistant);
    const availability = boundedString(assistant.availability, 32);
    if (availability === "configured") return "configured";
    if (boundedString(assistant.directReads, 32) === "configured") {
      return "direct_only";
    }
    return availability || "unknown";
  }

  function hasManagementSweepAuthority() {
    return (
      hasBrowserAuthority()
      && sessionCapabilities().includes(MANAGEMENT_SWEEP_CAPABILITY)
    );
  }

  function hasConnectorReadAuthority() {
    return (
      hasBrowserAuthority()
      && sessionCapabilities().includes(CONNECTOR_READ_CAPABILITY)
    );
  }

  function hasGoogleLinkAuthority() {
    return (
      hasBrowserAuthority()
      && sessionCapabilities().includes(GOOGLE_LINK_CAPABILITY)
    );
  }

  function hasQuoLineAuthority() {
    return (
      hasBrowserAuthority()
      && sessionCapabilities().includes(QUO_LINE_LINK_CAPABILITY)
    );
  }

  function managementSweepRuntimeStatus() {
    const runtime = record(record(state.session).runtime);
    return boundedString(
      record(runtime.connectors).managementSweep,
      32
    ) || "unknown";
  }

  function hasFileReviewAuthority() {
    return (
      hasWorkCenterAuthority() &&
      sessionCapabilities().includes(FILE_REVIEW_CAPABILITY)
    );
  }

  function hasActionReadAuthority() {
    return (
      hasBrowserAuthority()
      && sessionCapabilities().includes(ACTION_READ_CAPABILITY)
    );
  }

  function hasActionPrepareAuthority() {
    return (
      hasFileReviewAuthority()
      && hasActionReadAuthority()
      && sessionCapabilities().includes(ACTION_PREPARE_CAPABILITY)
    );
  }

  function hasActionInvalidateAuthority() {
    return (
      hasActionReadAuthority()
      && sessionCapabilities().includes(ACTION_INVALIDATE_CAPABILITY)
    );
  }

  function hasReceiptReadAuthority() {
    return (
      hasBrowserAuthority()
      && sessionCapabilities().includes(RECEIPT_READ_CAPABILITY)
    );
  }

  function syncOperationalAccess() {
    syncCapabilityAwareConsole();
    syncActionAccess();
    syncHomeGuidance();
    syncAssistantAccess();
    if (!navigator.onLine) {
      clearOperationalData("Reconnect to request fresh client evidence.");
      renderOperationsLocked(
        "Offline",
        "Client data was cleared from this page. Reconnect to run a fresh read."
      );
      return;
    }

    syncConnectionsAccess();
    syncManagementSweepAccess();

    if (!hasWorkCenterAuthority()) {
      const session = record(state.session);
      const identity = record(session.identity);
      const authenticated = session.authenticated === true &&
        identity.authentication === "authenticated";
      renderOperationsLocked(
        authenticated ? "Not authorized" : "Sign in required",
        authenticated
          ? "This HCN session does not have the assigned-file Work Center capability."
          : "Sign in with your HCN account to load fresh assigned files."
      );
      return;
    }

    elements["work-center-locked"].hidden = true;
    elements["work-center-workspace"].hidden = false;
    elements["work-center-refresh"].hidden = false;
    badge(elements["work-center-status"], "Read only", "good");
    setText(
      elements["work-center-summary"],
      "Fresh assigned-file evidence is available for your verified HCN session."
    );
    if (!state.workCenter && !state.workCenterLoading) {
      loadWorkCenter({ resetFile: true });
    }
  }

  function syncManagementSweepAccess() {
    if (!hasManagementSweepAuthority()) {
      const session = record(state.session);
      const identity = record(session.identity);
      const authenticated = session.authenticated === true
        && identity.authentication === "authenticated";
      renderManagementSweepLocked(
        authenticated ? "Not authorized" : "Sign in required",
        authenticated
          ? "This HCN session does not have the company management-sweep capability."
          : "Sign in with your HCN account to request a fresh company report."
      );
      return;
    }
    const runtimeStatus = managementSweepRuntimeStatus();
    if (runtimeStatus !== "configured") {
      renderManagementSweepLocked(
        runtimeStatus === "unconfigured"
          ? "Setup required"
          : "Readiness unknown",
        runtimeStatus === "unconfigured"
          ? "The three-adjuster allowlist, JobNimbus connection, and HCN reference configuration must all be ready before this report can run."
          : "The console could not verify the management-sweep configuration. Recheck platform status."
      );
      return;
    }

    elements["management-sweep-locked"].hidden = true;
    elements["management-sweep-workspace"].hidden = false;
    elements["management-sweep-refresh"].hidden = false;
    badge(elements["management-sweep-section-status"], "Ready to run", "good");
    if (!state.managementSweep && !state.managementSweepLoading) {
      setText(elements["management-sweep-status"], "Ready to run");
      setText(
        elements["management-sweep-hero-message"],
        "Run the sweep when you want a fresh company ranking."
      );
      notice(
        elements["management-sweep-alert"],
        "The report runs only when requested and does not change any client record.",
        "neutral"
      );
    }
  }

  function renderManagementSweepLocked(status, message) {
    elements["management-sweep-locked"].hidden = false;
    elements["management-sweep-workspace"].hidden = true;
    elements["management-sweep-refresh"].hidden = true;
    badge(elements["management-sweep-section-status"], status, "neutral");
    setText(elements["management-sweep-status"], status);
    setText(elements["management-sweep-hero-message"], message);
    notice(
      elements["management-sweep-alert"],
      "Company records are not loaded in this view.",
      "neutral"
    );
  }

  function renderOperationsLocked(status, message) {
    elements["work-center-locked"].hidden = false;
    elements["work-center-workspace"].hidden = true;
    elements["work-center-refresh"].hidden = true;
    elements["work-center-previous"].hidden = true;
    elements["work-center-next"].hidden = true;
    setText(elements["work-center-page"], "Page 1");
    badge(elements["work-center-status"], status, "neutral");
    setText(elements["work-center-summary"], message);
    notice(
      elements["work-center-alert"],
      "Client records are not loaded in this view.",
      "neutral"
    );
  }

  function clearOperationalData(message) {
    clearAssistantData(
      message || "The conversation was cleared because operating authority changed."
    );
    clearConnectionsData(message);
    clearManagementSweepData(message);
    if (state.workCenterController) state.workCenterController.abort();
    if (state.fileController) state.fileController.abort();
    if (state.actionController) state.actionController.abort();
    if (state.receiptController) state.receiptController.abort();
    state.workCenterController = null;
    state.fileController = null;
    state.actionController = null;
    state.receiptController = null;
    state.workCenterLoading = false;
    state.fileLoading = false;
    state.workCenter = null;
    state.workCenterOffset = 0;
    state.selectedFileRef = null;
    state.fileReview = null;

    elements["work-center-list"].setAttribute("aria-busy", "false");
    elements["work-center-refresh"].disabled = false;
    elements["work-center-previous"].disabled = false;
    elements["work-center-next"].disabled = false;
    elements["work-center-previous"].hidden = true;
    elements["work-center-next"].hidden = true;
    elements["file-refresh"].disabled = false;
    setText(elements["work-center-count"], "—");
    setText(elements["work-center-page"], "Page 1");
    setText(elements["work-center-freshness"], "No client records are retained on this page.");
    renderWorkspaceEmpty(elements["work-center-list"], message || "Fresh data is not loaded.");
    closeFileReview();
    clearActionControlData(
      message || "Action plans and receipt metadata are not retained on this page."
    );
  }

  function clearManagementSweepData(message) {
    cancelManagementSweepExpiryTimer();
    if (state.managementSweepController) {
      state.managementSweepController.abort();
    }
    state.managementSweepController = null;
    state.managementSweepLoading = false;
    state.managementSweep = null;
    elements["management-sweep-refresh"].disabled = false;
    elements["company-worst-list"].setAttribute("aria-busy", "false");
    elements["adjuster-sweep-list"].setAttribute("aria-busy", "false");
    setText(elements["management-sweep-adjuster-count"], "—");
    setText(elements["management-sweep-file-count"], "—");
    setText(elements["management-sweep-completeness"], "JobNimbus only");
    setText(elements["management-sweep-generated"], "No client records are retained on this page.");
    setText(elements["company-worst-count"], "0");
    elements["management-sweep-source-health"].replaceChildren();
    renderWorkspaceEmpty(
      elements["company-worst-list"],
      message || "Run a fresh sweep to see company priorities."
    );
    renderWorkspaceEmpty(
      elements["adjuster-sweep-list"],
      message || "No management report is loaded."
    );
    elements["management-sweep-exclusions"].hidden = true;
    elements["management-sweep-exclusions"].open = false;
    setText(elements["management-sweep-exclusion-count"], "0");
    elements["management-sweep-exclusion-list"].replaceChildren();
    renderManagementSweepLocked(
      "Checking authority",
      message || "Verifying the signed-in session before loading company records."
    );
  }

  function syncConnectionsAccess() {
    if (!navigator.onLine) {
      renderConnectionsLocked(
        "Offline",
        "Reconnect to verify your HCN session and work-account connections."
      );
      return;
    }
    if (!hasConnectorReadAuthority()) {
      const session = record(state.session);
      const identity = record(session.identity);
      const authenticated = session.authenticated === true
        && identity.authentication === "authenticated"
        && identity.type === "hcn_browser_session";
      renderConnectionsLocked(
        authenticated ? "Not authorized" : "Sign in required",
        authenticated
          ? "This HCN session cannot read employee connection status."
          : "Sign in with your HCN account to check and link your work accounts."
      );
      return;
    }

    elements["connections-locked"].hidden = true;
    elements["connections-workspace"].hidden = false;
    elements["connections-refresh"].hidden = false;
    elements["connections-refresh"].disabled = state.connectionsLoading;
    badge(
      elements["connections-status"],
      state.connectionsLoading ? "Checking" : "Ready",
      state.connectionsLoading ? "neutral" : "good"
    );
    syncConnectionControls();
    if (!state.connections && !state.connectionsLoading) {
      loadConnections();
    }
  }

  function renderConnectionsLocked(status, message) {
    elements["connections-locked"].hidden = false;
    elements["connections-workspace"].hidden = true;
    elements["connections-refresh"].hidden = true;
    elements["google-connect-action"].hidden = true;
    elements["quo-phone-form"].hidden = true;
    elements["quo-verify-form"].hidden = true;
    badge(elements["connections-status"], status, "neutral");
    notice(
      elements["connections-alert"],
      message || "Connection details are not loaded.",
      "neutral"
    );
  }

  function clearConnectionsData(message) {
    if (state.connectionsController) state.connectionsController.abort();
    if (state.quoController) state.quoController.abort();
    state.connectionsController = null;
    state.quoController = null;
    state.connectionsLoading = false;
    state.quoMutationLoading = false;
    state.quoChallengePending = false;
    state.connections = null;

    elements["connections-refresh"].disabled = false;
    elements["google-connect-action"].disabled = false;
    elements["quo-start"].disabled = false;
    elements["quo-verify"].disabled = false;
    elements["quo-phone-form"].reset();
    elements["quo-verify-form"].reset();
    setText(elements["connections-profile-name"], "—");
    setText(elements["connections-profile-role"], "—");
    badge(elements["jobnimbus-connection-status"], "Not loaded", "neutral");
    badge(elements["google-connection-status"], "Not loaded", "neutral");
    badge(elements["quo-connection-status"], "Not loaded", "neutral");
    setText(
      elements["jobnimbus-connection-detail"],
      "No assigned-file identity is retained on this page."
    );
    setText(elements["google-gmail-status"], "Not loaded");
    setText(elements["google-calendar-status"], "Not loaded");
    setText(
      elements["quo-connection-detail"],
      "No linked-line detail is retained on this page."
    );
    renderConnectionsLocked(
      "Checking authority",
      message || "Verifying your HCN session before loading connection details."
    );
  }

  async function loadConnections() {
    if (!hasConnectorReadAuthority()) {
      syncConnectionsAccess();
      return;
    }
    if (!navigator.onLine) {
      clearConnectionsData("Reconnect to check your work-account connections.");
      syncConnectionsAccess();
      return;
    }

    if (state.connectionsController) state.connectionsController.abort();
    const controller = new AbortController();
    state.connectionsController = controller;
    state.connectionsLoading = true;
    state.connections = null;
    syncHomeGuidance();
    elements["connections-locked"].hidden = true;
    elements["connections-workspace"].hidden = false;
    elements["connections-refresh"].hidden = false;
    elements["connections-refresh"].disabled = true;
    badge(elements["connections-status"], "Checking", "neutral");
    renderConnectionsLoading();
    notice(
      elements["connections-alert"],
      "Checking your work-account connections. No credential values are loaded.",
      "neutral"
    );
    syncConnectionControls();

    try {
      const response = await postOperationalJson(
        ENDPOINTS.connectorsStatus,
        {},
        controller.signal,
        CONNECTOR_READ_CAPABILITY
      );
      if (controller.signal.aborted) return;
      let connections = normalizeConnectionsResponse(response);

      if (hasQuoLineAuthority()) {
        try {
          const quoStatus = await postOperationalJson(
            ENDPOINTS.quoLine,
            { mode: "status" },
            controller.signal,
            QUO_LINE_LINK_CAPABILITY
          );
          if (controller.signal.aborted) return;
          connections = Object.assign({}, connections, {
            quo: normalizeQuoLineStatus(quoStatus, connections.quo)
          });
        } catch (error) {
          if (controller.signal.aborted) return;
          if (statusOf(error) === 401) {
            handleOperationalAuthLoss();
            return;
          }
        }
      }

      state.connections = connections;
      renderConnections(connections);
      renderGoogleCallbackOutcome(connections);
    } catch (error) {
      if (controller.signal.aborted) return;
      state.connections = null;
      if (statusOf(error) === 401) {
        handleOperationalAuthLoss();
        return;
      }
      if (statusOf(error) === 403) {
        renderConnectionsLocked(
          "Not authorized",
          "This HCN session cannot read employee connection status."
        );
        return;
      }
      badge(elements["connections-status"], "Unavailable", "bad");
      badge(elements["jobnimbus-connection-status"], "Unavailable", "bad");
      badge(elements["google-connection-status"], "Unavailable", "bad");
      badge(elements["quo-connection-status"], "Unavailable", "bad");
      setText(
        elements["jobnimbus-connection-detail"],
        "Your assigned-file identity could not be verified."
      );
      setText(elements["google-gmail-status"], "Unavailable");
      setText(elements["google-calendar-status"], "Unavailable");
      setText(
        elements["quo-connection-detail"],
        "Your linked-line status could not be verified."
      );
      notice(
        elements["connections-alert"],
        connectionErrorMessage(error),
        "bad"
      );
      renderGoogleCallbackOutcome(null);
      syncConnectionControls();
    } finally {
      if (state.connectionsController === controller) {
        state.connectionsController = null;
        state.connectionsLoading = false;
        elements["connections-refresh"].disabled = false;
        syncConnectionControls();
        syncHomeGuidance();
      }
    }
  }

  function renderGoogleCallbackOutcome(connections) {
    const outcome = state.googleCallbackOutcome;
    if (!outcome) return;
    state.googleCallbackOutcome = "";
    if (!connections) {
      notice(
        elements["connections-alert"],
        "Google returned to HCN, but the current connection status could not be verified. No connection change is assumed.",
        "bad"
      );
      return;
    }
    if (outcome === "connected") {
      if (record(connections.google).status !== "connected") {
        notice(
          elements["connections-alert"],
          "Google returned, but a fresh check did not confirm the connection. No connection change is assumed.",
          "bad"
        );
        return;
      }
      notice(
        elements["connections-alert"],
        "Google returned successfully. The connection status shown here was verified again.",
        "good"
      );
      return;
    }
    if (outcome === "cancelled") {
      notice(
        elements["connections-alert"],
        "Google linking was cancelled. The verified connection status is shown below.",
        "warn"
      );
      return;
    }
    if (outcome === "temporarily_unavailable") {
      notice(
        elements["connections-alert"],
        "Google linking is temporarily unavailable. The verified connection status is shown below.",
        "warn"
      );
      return;
    }
    notice(
      elements["connections-alert"],
      "Google could not complete linking. The verified connection status is shown below.",
      "bad"
    );
  }

  function renderConnectionsLoading() {
    const profile = record(record(state.session).profile);
    setText(
      elements["connections-profile-name"],
      boundedString(profile.displayName, 100) || "Signed-in employee"
    );
    setText(
      elements["connections-profile-role"],
      humanize(boundedString(profile.role, 64) || "HCN employee")
    );
    badge(elements["jobnimbus-connection-status"], "Checking", "neutral");
    badge(elements["google-connection-status"], "Checking", "neutral");
    badge(elements["quo-connection-status"], "Checking", "neutral");
    setText(
      elements["jobnimbus-connection-detail"],
      "Checking your assigned-file identity."
    );
    setText(elements["google-gmail-status"], "Checking");
    setText(elements["google-calendar-status"], "Checking");
    setText(
      elements["quo-connection-detail"],
      "Checking whether your work line is linked."
    );
    elements["google-connect-action"].hidden = true;
    elements["quo-phone-form"].hidden = true;
    elements["quo-verify-form"].hidden = true;
  }

  function normalizeConnectionsResponse(value) {
    if (
      value.schema !== "hcn.console.connectors.v1"
      || !isRecord(value.profile)
      || !isRecord(value.jobNimbus)
      || !isRecord(value.google)
      || !isRecord(value.quo)
    ) {
      throw new Error("Invalid Connections response");
    }

    const generatedAt = boundedString(value.generatedAt, 40);
    if (generatedAt && Number.isNaN(new Date(generatedAt).getTime())) {
      throw new Error("Invalid Connections timestamp");
    }
    const jobNimbusStatus = connectionStatus(value.jobNimbus.status);
    if (
      !["connected", "unavailable"].includes(jobNimbusStatus)
      || value.jobNimbus.scope !== "assigned"
    ) {
      throw new Error("Invalid JobNimbus connection");
    }
    const googleStatus = connectionStatus(value.google.status);
    const gmailStatus = connectionStatus(value.google.gmail);
    const calendarStatus = connectionStatus(value.google.calendar);
    const connectUrl = boundedString(value.google.connectUrl, 120);
    if (connectUrl && connectUrl !== ENDPOINTS.googleConnectStart) {
      throw new Error("Invalid Google connection path");
    }
    const quoStatus = connectionStatus(value.quo.status);

    return {
      generatedAt: generatedAt,
      profile: {
        displayName: boundedString(value.profile.displayName, 100),
        role: boundedString(value.profile.role, 64)
      },
      jobNimbus: {
        status: jobNimbusStatus,
        scope: "assigned"
      },
      google: {
        status: googleStatus,
        gmail: gmailStatus,
        calendar: calendarStatus,
        connectUrl: ENDPOINTS.googleConnectStart
      },
      quo: {
        status: quoStatus,
        line: normalizeSafeQuoLine(value.quo.line)
      }
    };
  }

  function normalizeQuoLineStatus(value, fallback) {
    const current = record(fallback);
    const mode = boundedString(value.mode, 16);
    if (mode && mode !== "status") {
      throw new Error("Invalid Quo status response");
    }
    if (typeof value.linked !== "boolean") {
      return {
        status: connectionStatus(current.status),
        line: normalizeSafeQuoLine(current.line)
      };
    }
    return {
      status: value.linked ? "connected" : "not_connected",
      line: value.linked ? normalizeSafeQuoLine(value.line) : null
    };
  }

  function normalizeSafeQuoLine(value) {
    if (!isRecord(value)) return null;
    const name = safeLineName(value.name);
    const maskedNumber = safeMaskedPhone(value.maskedNumber);
    return name || maskedNumber
      ? { name: name, maskedNumber: maskedNumber }
      : null;
  }

  function safeLineName(value) {
    const name = boundedString(value, 80);
    if (!name) return "";
    const digits = name.match(/\d/g) || [];
    return digits.length >= 7 ? "" : name;
  }

  function safeMaskedPhone(value) {
    const masked = boundedString(value, 40);
    if (!masked || !/^[0-9*•xX()+.\s-]+$/.test(masked)) return "";
    const digits = masked.match(/\d/g) || [];
    return digits.length <= 4 ? masked : "";
  }

  function connectionStatus(value) {
    const status = boundedString(value, 32);
    if (!CONNECTION_STATUSES.has(status)) {
      throw new Error("Invalid connection status");
    }
    return status;
  }

  function renderConnections(connections) {
    setText(
      elements["connections-profile-name"],
      connections.profile.displayName || "Signed-in employee"
    );
    setText(
      elements["connections-profile-role"],
      humanize(connections.profile.role || "HCN employee")
    );

    renderConnectionBadge(
      elements["jobnimbus-connection-status"],
      connections.jobNimbus.status
    );
    setText(
      elements["jobnimbus-connection-detail"],
      connections.jobNimbus.status === "connected"
        ? "Connected with assigned-file scope."
        : "Your assigned JobNimbus identity is unavailable."
    );

    renderConnectionBadge(
      elements["google-connection-status"],
      connections.google.status
    );
    setText(
      elements["google-gmail-status"],
      connectionStatusLabel(connections.google.gmail)
    );
    setText(
      elements["google-calendar-status"],
      connectionStatusLabel(connections.google.calendar)
    );

    renderConnectionBadge(
      elements["quo-connection-status"],
      connections.quo.status
    );
    const line = connections.quo.line;
    const lineDetail = line
      ? [line.name, line.maskedNumber].filter(Boolean).join(" · ")
      : "";
    setText(
      elements["quo-connection-detail"],
      connections.quo.status === "connected"
        ? lineDetail || "Your Quo work line is linked."
        : connections.quo.status === "not_connected"
          ? "Link the Quo work line you use for client calls and texts."
          : "Quo line status is currently unavailable."
    );

    badge(elements["connections-status"], "Current", "good");
    notice(
      elements["connections-alert"],
      connections.generatedAt
        ? "Connection status checked " + readableDateTime(connections.generatedAt) + "."
        : "Connection status is current for this session.",
      "good"
    );
    syncConnectionControls();
  }

  function renderConnectionBadge(element, status) {
    badge(element, connectionStatusLabel(status), connectionStatusTone(status));
  }

  function connectionStatusLabel(status) {
    if (status === "connected") return "Connected";
    if (status === "not_connected") return "Not connected";
    return "Unavailable";
  }

  function connectionStatusTone(status) {
    if (status === "connected") return "good";
    if (status === "not_connected") return "warn";
    return "bad";
  }

  function syncConnectionControls() {
    const connections = record(state.connections);
    const google = record(connections.google);
    const quo = record(connections.quo);
    const canLinkGoogle = (
      navigator.onLine
      && hasGoogleLinkAuthority()
      && (
        google.status === "not_connected"
        || google.status === "connected"
      )
      && !state.connectionsLoading
    );
    const canLinkQuo = (
      navigator.onLine
      && hasQuoLineAuthority()
      && (
        quo.status === "not_connected"
        || quo.status === "connected"
      )
      && !state.connectionsLoading
    );

    elements["google-connect-action"].hidden = !canLinkGoogle;
    elements["google-connect-action"].disabled = state.connectionsLoading;
    setText(
      elements["google-connect-action"],
      google.status === "connected" ? "Reconnect Google" : "Connect Google"
    );
    elements["quo-phone-form"].hidden = !canLinkQuo || state.quoChallengePending;
    elements["quo-verify-form"].hidden = !canLinkQuo || !state.quoChallengePending;
    setText(
      elements["quo-start"],
      quo.status === "connected" ? "Verify a different line" : "Send code"
    );
    elements["quo-start"].disabled = state.quoMutationLoading;
    elements["quo-use-code"].disabled = state.quoMutationLoading;
    elements["quo-verify"].disabled = state.quoMutationLoading;
    elements["quo-restart"].disabled = state.quoMutationLoading;
  }

  function startGoogleConnection() {
    if (!navigator.onLine || !hasGoogleLinkAuthority()) {
      notice(
        elements["connections-alert"],
        "Google linking is not available for this HCN session.",
        "warn"
      );
      return;
    }
    elements["google-connect-action"].disabled = true;
    window.location.assign(ENDPOINTS.googleConnectStart);
  }

  async function startQuoConnection(event) {
    event.preventDefault();
    if (!navigator.onLine || !hasQuoLineAuthority() || state.quoMutationLoading) {
      notice(
        elements["connections-alert"],
        "Quo line linking is not available for this HCN session.",
        "warn"
      );
      return;
    }
    const phone = boundedString(elements["quo-phone"].value.trim(), 24);
    const digits = phone.match(/\d/g) || [];
    if (
      digits.length < 7
      || digits.length > 15
      || !/^[0-9()+.\s-]+$/.test(phone)
    ) {
      notice(
        elements["connections-alert"],
        "Enter the work phone number that should receive the Quo verification code.",
        "warn"
      );
      return;
    }

    await mutateQuoLine(
      { mode: "start", phone: phone },
      "A verification code was sent to that work line.",
      async function (response) {
        elements["quo-phone-form"].reset();
        if (record(response).linked === true && !record(response).verification) {
          state.quoChallengePending = false;
          await loadConnections();
          notice(
            elements["connections-alert"],
            "That Quo line is already verified for your HCN account.",
            "good"
          );
          return;
        }
        state.quoChallengePending = true;
        syncConnectionControls();
        elements["quo-code"].focus();
      }
    );
  }

  function showQuoCodeEntry() {
    if (!navigator.onLine || !hasQuoLineAuthority() || state.quoMutationLoading) {
      return;
    }
    state.quoChallengePending = true;
    syncConnectionControls();
    notice(
      elements["connections-alert"],
      "Enter the six-digit code already sent to your Quo work line.",
      "neutral"
    );
    elements["quo-code"].focus();
  }

  function restartQuoConnection() {
    if (state.quoMutationLoading) return;
    elements["quo-verify-form"].reset();
    state.quoChallengePending = false;
    syncConnectionControls();
    notice(
      elements["connections-alert"],
      "Enter your Quo work number to request a new verification code.",
      "neutral"
    );
    elements["quo-phone"].focus();
  }

  async function verifyQuoConnection(event) {
    event.preventDefault();
    if (!navigator.onLine || !hasQuoLineAuthority() || state.quoMutationLoading) {
      notice(
        elements["connections-alert"],
        "Quo line verification is not available for this HCN session.",
        "warn"
      );
      return;
    }
    const code = boundedString(elements["quo-code"].value.trim(), 6);
    if (!/^\d{6}$/.test(code)) {
      notice(
        elements["connections-alert"],
        "Enter the six-digit Quo verification code.",
        "warn"
      );
      return;
    }

    await mutateQuoLine(
      { mode: "verify", code: code },
      "The Quo line was verified. Refreshing its safe connection status.",
      async function () {
        elements["quo-verify-form"].reset();
        state.quoChallengePending = false;
        await loadConnections();
      }
    );
  }

  async function mutateQuoLine(body, successMessage, onSuccess) {
    if (state.quoController) state.quoController.abort();
    const controller = new AbortController();
    state.quoController = controller;
    state.quoMutationLoading = true;
    syncConnectionControls();
    notice(elements["connections-alert"], "Verifying the Quo work line.", "neutral");

    try {
      const response = await postOperationalJson(
        ENDPOINTS.quoLine,
        body,
        controller.signal,
        QUO_LINE_LINK_CAPABILITY
      );
      if (controller.signal.aborted) return;
      notice(elements["connections-alert"], successMessage, "good");
      await onSuccess(response);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (statusOf(error) === 401) {
        handleOperationalAuthLoss();
        return;
      }
      notice(
        elements["connections-alert"],
        statusOf(error) === 403
          ? "This HCN session cannot link a Quo line."
          : "The Quo line could not be verified. No connection change is assumed.",
        "bad"
      );
    } finally {
      if (state.quoController === controller) {
        state.quoController = null;
        state.quoMutationLoading = false;
        syncConnectionControls();
      }
    }
  }

  function connectionErrorMessage(error) {
    if (!navigator.onLine) {
      return "The connection went offline. No connection details are retained.";
    }
    if (statusOf(error) === 502 || statusOf(error) === 503) {
      return "Work-account connection status is temporarily unavailable.";
    }
    return "Your work-account connections could not be verified.";
  }

  async function loadManagementSweep() {
    if (
      !hasManagementSweepAuthority()
      || managementSweepRuntimeStatus() !== "configured"
    ) {
      syncManagementSweepAccess();
      return;
    }
    if (!navigator.onLine) {
      clearOperationalData("Reconnect to request a fresh company management sweep.");
      syncOperationalAccess();
      return;
    }

    cancelManagementSweepExpiryTimer();
    if (state.managementSweepController) {
      state.managementSweepController.abort();
    }
    const controller = new AbortController();
    state.managementSweepController = controller;
    state.managementSweepLoading = true;
    state.managementSweep = null;
    syncHomeGuidance();

    elements["management-sweep-locked"].hidden = true;
    elements["management-sweep-workspace"].hidden = false;
    elements["management-sweep-refresh"].hidden = false;
    elements["management-sweep-refresh"].disabled = true;
    elements["company-worst-list"].setAttribute("aria-busy", "true");
    elements["adjuster-sweep-list"].setAttribute("aria-busy", "true");
    badge(elements["management-sweep-section-status"], "Running fresh sweep", "neutral");
    setText(elements["management-sweep-status"], "Checking company files");
    setText(
      elements["management-sweep-hero-message"],
      "Reviewing fresh JobNimbus activity for the configured adjusters."
    );
    notice(
      elements["management-sweep-alert"],
      "Building a fresh read-only management report. No client record will be changed.",
      "neutral"
    );
    setText(elements["management-sweep-adjuster-count"], "—");
    setText(elements["management-sweep-file-count"], "—");
    setText(elements["management-sweep-completeness"], "Checking JobNimbus");
    setText(elements["management-sweep-generated"], "Fresh read in progress.");
    setText(elements["company-worst-count"], "0");
    elements["management-sweep-source-health"].replaceChildren();
    renderWorkspaceEmpty(
      elements["company-worst-list"],
      "Finding the company’s highest verified attention gaps…"
    );
    renderWorkspaceEmpty(
      elements["adjuster-sweep-list"],
      "Ranking up to ten eligible files for each adjuster…"
    );

    try {
      const response = await postOperationalJson(
        ENDPOINTS.managementSweep,
        { limitPerAdjuster: 10 },
        controller.signal,
        MANAGEMENT_SWEEP_CAPABILITY
      );
      if (controller.signal.aborted) return;
      const receivedAtMs = Date.now();
      state.managementSweep = normalizeManagementSweepResponse(
        response,
        receivedAtMs
      );
      renderManagementSweep(state.managementSweep);
      scheduleManagementSweepExpiry(state.managementSweep);
    } catch (error) {
      if (controller.signal.aborted) return;
      cancelManagementSweepExpiryTimer();
      state.managementSweep = null;
      if (isAuthorizationStatus(error)) {
        handleOperationalAuthLoss();
        return;
      }
      const message = managementSweepErrorMessage(error);
      badge(elements["management-sweep-section-status"], "Unavailable", "bad");
      setText(elements["management-sweep-status"], "Report unavailable");
      setText(elements["management-sweep-completeness"], "JobNimbus unavailable");
      setText(elements["management-sweep-generated"], "No stale report is shown.");
      setText(elements["management-sweep-hero-message"], message);
      notice(elements["management-sweep-alert"], message, "bad");
      renderWorkspaceEmpty(elements["company-worst-list"], "No company ranking is shown.");
      renderWorkspaceEmpty(elements["adjuster-sweep-list"], "No adjuster ranking is shown.");
      elements["management-sweep-source-health"].replaceChildren();
    } finally {
      if (state.managementSweepController === controller) {
        state.managementSweepController = null;
        state.managementSweepLoading = false;
        elements["management-sweep-refresh"].disabled = false;
        elements["company-worst-list"].setAttribute("aria-busy", "false");
        elements["adjuster-sweep-list"].setAttribute("aria-busy", "false");
        syncHomeGuidance();
      }
    }
  }

  function normalizeManagementSweepResponse(value, receivedAtMs) {
    const schemaVersion = boundedString(
      value && (value.schemaVersion || value.schema),
      80
    );
    const generatedAt = boundedString(value && value.generatedAt, 40);
    const checkedAt = boundedString(value && value.checkedAt, 40);
    const validUntil = boundedString(value && value.validUntil, 40);
    const generatedAtMs = canonicalTimestampMs(generatedAt);
    const checkedAtMs = canonicalTimestampMs(checkedAt);
    const validUntilMs = canonicalTimestampMs(validUntil);
    if (
      !isRecord(value)
      || schemaVersion !== "hcn.console.management-sweep.v1"
      || value.cachePolicy !== "no_store"
      || !Array.isArray(value.adjusters)
      || value.adjusters.length !== 3
      || !Number.isFinite(receivedAtMs)
      || !Number.isFinite(generatedAtMs)
      || !Number.isFinite(checkedAtMs)
      || !Number.isFinite(validUntilMs)
      || generatedAtMs > checkedAtMs
      || checkedAtMs >= validUntilMs
      || receivedAtMs >= validUntilMs
    ) {
      throw new Error("Invalid management sweep response");
    }

    const adjusters = value.adjusters.map(function (candidate, index) {
      const adjuster = record(candidate);
      const id = boundedString(
        adjuster.id || adjuster.adjusterRef || adjuster.ownerRef,
        96
      );
      const name = boundedString(
        adjuster.name || adjuster.displayName || adjuster.adjusterName,
        96
      );
      if (!id || !name) {
        throw new Error(
          "Management sweep adjuster " + String(index + 1) + " is incomplete"
        );
      }
      if (!Array.isArray(adjuster.items) || adjuster.items.length > 10) {
        throw new Error("Invalid management sweep adjuster items");
      }
      const items = adjuster.items.map(function (item, itemIndex) {
        return normalizeSweepItem(item, itemIndex, "adjuster");
      });
      return {
        id: id,
        name: name,
        eligibleCount: Number.isInteger(adjuster.eligibleCount)
          && adjuster.eligibleCount >= 0
          ? adjuster.eligibleCount
          : items.length,
        requestedCount: Number.isInteger(adjuster.requestedCount)
          && adjuster.requestedCount > 0
          && adjuster.requestedCount <= 10
          ? adjuster.requestedCount
          : 10,
        shortage: {
          isShort: record(adjuster.shortage).isShort === true,
          missingCount: Number.isInteger(record(adjuster.shortage).missingCount)
            && record(adjuster.shortage).missingCount >= 0
            ? record(adjuster.shortage).missingCount
            : 0,
          reasonCode: boundedString(record(adjuster.shortage).reasonCode, 96)
        },
        items: items
      };
    });

    const companyWorstSource = Array.isArray(value.companyWorst)
      ? value.companyWorst
      : Array.isArray(record(value.companyWorst).items)
        ? value.companyWorst.items
        : [];
    if (companyWorstSource.length > 10) {
      throw new Error("Invalid company management ranking");
    }
    const companyWorst = companyWorstSource.map(function (item, itemIndex) {
      return normalizeSweepItem(item, itemIndex, "company");
    });
    const completeness = normalizeSweepCompleteness(
      value.completeness,
      value.summary,
      value.criteria
    );
    const rankingMode = boundedString(
      record(value.criteria).rankingMode || value.rankingMode,
      64
    );
    const sourceHealth = normalizeSweepSourceHealth(value.sourceHealth);
    if (!sourceHealth.length && rankingMode === "activity_only") {
      sourceHealth.push({
        key: "jobnimbus",
        label: "JobNimbus",
        status: completeness.status === "complete"
          ? "fresh"
          : completeness.status === "insufficient"
            ? "unavailable"
            : "partial",
        detail: completeness.summary
      });
    }

    return {
      schema: schemaVersion,
      generatedAt: generatedAt,
      checkedAt: checkedAt,
      validUntil: validUntil,
      sourceHealth: sourceHealth,
      completeness: completeness,
      rankingMode: rankingMode,
      adjusters: adjusters,
      companyWorst: companyWorst,
      exclusions: normalizeSweepExclusions(value.exclusions)
    };
  }

  function canonicalTimestampMs(value) {
    if (typeof value !== "string" || !value || value.length > 40) return NaN;
    const milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds)) return NaN;
    return new Date(milliseconds).toISOString() === value
      ? milliseconds
      : NaN;
  }

  function scheduleManagementSweepExpiry(sweep) {
    cancelManagementSweepExpiryTimer();
    const validUntilMs = canonicalTimestampMs(record(sweep).validUntil);
    if (!Number.isFinite(validUntilMs) || Date.now() >= validUntilMs) {
      expireManagementSweep();
      return false;
    }
    state.managementSweepExpiryTimer = window.setTimeout(
      enforceManagementSweepExpiry,
      Math.min(
        MAX_TIMER_DELAY_MS,
        Math.max(1, validUntilMs - Date.now())
      )
    );
    return true;
  }

  function cancelManagementSweepExpiryTimer() {
    if (state.managementSweepExpiryTimer !== null) {
      window.clearTimeout(state.managementSweepExpiryTimer);
    }
    state.managementSweepExpiryTimer = null;
  }

  function enforceManagementSweepExpiry() {
    if (!state.managementSweep) {
      cancelManagementSweepExpiryTimer();
      return;
    }
    const validUntilMs = canonicalTimestampMs(
      record(state.managementSweep).validUntil
    );
    if (!Number.isFinite(validUntilMs) || Date.now() >= validUntilMs) {
      expireManagementSweep();
      return;
    }
    scheduleManagementSweepExpiry(state.managementSweep);
  }

  function expireManagementSweep() {
    if (!state.managementSweep) {
      cancelManagementSweepExpiryTimer();
      return;
    }
    const message =
      "The management sweep expired and was cleared. Run a fresh sweep to continue.";
    clearManagementSweepData(message);
    if (!navigator.onLine) {
      renderManagementSweepLocked("Offline", message);
      return;
    }
    if (!hasManagementSweepAuthority()) {
      syncManagementSweepAccess();
      return;
    }
    elements["management-sweep-locked"].hidden = true;
    elements["management-sweep-workspace"].hidden = false;
    elements["management-sweep-refresh"].hidden = false;
    badge(elements["management-sweep-section-status"], "Report expired", "warn");
    setText(elements["management-sweep-status"], "Fresh report required");
    setText(elements["management-sweep-hero-message"], message);
    notice(
      elements["management-sweep-alert"],
      "No expired company ranking is retained or shown.",
      "warn"
    );
  }

  function normalizeSweepItem(candidate, index, rankingScope) {
    const item = record(candidate);
    const fileRef = boundedString(item.fileRef, 80);
    if (!FILE_REF.test(fileRef)) {
      throw new Error("Invalid management sweep file reference");
    }
    const display = isRecord(item.display)
      ? item.display
      : isRecord(item.fileDisplay)
        ? item.fileDisplay
        : {};
    const status = isRecord(item.status) ? item.status : {};
    const attention = normalizeSweepAttention(item.attention);
    const gaps = normalizeSweepGaps(item.gaps);
    const meaningfulTouch = gaps.find(function (gap) {
      return gap.key === "anyMeaningfulTouch";
    });
    const operationalTouch = gaps.find(function (gap) {
      return gap.key === "operationalActivity";
    });
    const explicitLastTouch = normalizeSweepNarrative(item.lastTouch);
    const lastTouch = explicitLastTouch.summary || explicitLastTouch.at
      ? explicitLastTouch
      : meaningfulTouch && meaningfulTouch.lastAt
        ? {
            summary: "Meaningful JobNimbus activity",
            at: meaningfulTouch.lastAt,
            source: meaningfulTouch.source || "jobnimbus",
            actor: ""
          }
        : operationalTouch && operationalTouch.basis === "active_since"
          ? {
              summary: "No verified JobNimbus operational event",
              at: operationalTouch.sinceAt,
              source: "jobnimbus",
              actor: ""
            }
        : explicitLastTouch;
    const explicitRiskFlags = Array.isArray(item.riskFlags)
      ? item.riskFlags
      : [];
    return {
      rank: rankingScope === "adjuster"
        && Number.isInteger(item.adjusterRank)
        && item.adjusterRank > 0
        ? item.adjusterRank
        : rankingScope === "company"
          && Number.isInteger(item.companyRank)
          && item.companyRank > 0
          ? item.companyRank
          : Number.isInteger(item.rank) && item.rank > 0
            ? item.rank
            : Number(index) + 1,
      fileRef: fileRef,
      displayName: boundedString(
        typeof item.display === "string"
          ? item.display
          : display.name || display.displayName || item.displayName,
        120
      ),
      jobNumber: boundedString(
        display.jobNumber || item.jobNumber,
        64
      ),
      status: boundedString(
        display.status
          || display.statusLabel
          || (
            typeof item.status === "string"
              ? item.status
              : status.label
            || status.code
            || status.statusCode
            || item.statusCode
          ),
        96
      ),
      attention: attention,
      gaps: gaps,
      lastTouch: lastTouch,
      blocker: normalizeSweepNarrative(item.blocker),
      nextAction: normalizeSweepNarrative(item.nextAction),
      riskFlags: explicitRiskFlags.concat(attention.reasonCodes)
        .slice(0, 10).map(function (flag) {
            return boundedString(
              typeof flag === "string"
                ? flag
                : record(flag).label || record(flag).code,
              96
            );
          }).filter(Boolean),
      evidenceHealth: normalizeSweepEvidenceHealth(
        item.evidenceHealth,
        item.eventSummary
      ),
      eventSummary: normalizeSweepEventSummary(item.eventSummary)
    };
  }

  function normalizeSweepAttention(value) {
    const source = record(value);
    return {
      days: normalizeGapDays(
        source.unresolvedGapDays !== undefined
          ? source.unresolvedGapDays
          : source.days
      ),
      reasonCodes: Array.isArray(source.reasonCodes)
        ? source.reasonCodes.slice(0, 10).map(function (reason) {
            return boundedString(reason, 96);
          }).filter(Boolean)
        : []
    };
  }

  function normalizeSweepGaps(value) {
    const source = record(value);
    const preferredOrder = [
      ["successfulCommunication", "JobNimbus communication record"],
      ["contactAttempt", "Recorded contact attempt"],
      ["operationalActivity", "JobNimbus activity"],
      ["assignedAdjusterActivity", "Assigned-adjuster activity"],
      ["anyMeaningfulTouch", "JobNimbus activity"],
      ["communicationDays", "JobNimbus communication record"],
      ["activityDays", "JobNimbus activity"],
      ["assignedAdjusterDays", "Assigned-adjuster activity"],
      ["adjusterDays", "Assigned-adjuster activity"],
      ["companyDays", "Company JobNimbus activity"],
      ["contactAttemptDays", "Recorded contact attempt"],
      ["lastMeaningfulTouchDays", "JobNimbus activity"]
    ];
    const seenLabels = new Set();
    const gaps = [];

    preferredOrder.forEach(function (definition) {
      const normalized = normalizeSweepGap(
        source[definition[0]],
        definition[0],
        definition[1]
      );
      if (!normalized || seenLabels.has(definition[1])) return;
      seenLabels.add(definition[1]);
      gaps.push(normalized);
    });

    Object.keys(source).slice(0, 16).forEach(function (key) {
      if (preferredOrder.some(function (definition) {
          return definition[0] === key;
      })) return;
      const label = humanize(key.replace(/Days$/i, ""));
      const normalized = normalizeSweepGap(source[key], key, label);
      if (!normalized || normalized.days === null) return;
      if (seenLabels.has(label)) return;
      seenLabels.add(label);
      gaps.push(normalized);
    });
    return gaps.slice(0, 8);
  }

  function normalizeSweepGap(value, key, label) {
    if (value === undefined || value === null) return null;
    const source = record(value);
    const days = normalizeGapDays(value);
    const basis = boundedString(source.basis || source.status || source.state, 96);
    const explicitlyUnavailable = source.available === false
      || /\bunavailable|unsupported|not[_ ]available\b/i.test(basis);
    if (days === null && !isRecord(value)) return null;
    return {
      key: boundedString(key, 64),
      label: label,
      days: days,
      available: days !== null && !explicitlyUnavailable,
      lastAt: boundedString(source.lastAt, 40),
      sinceAt: boundedString(source.sinceAt, 40),
      source: boundedString(source.lastSource || source.source, 64),
      basis: basis
    };
  }

  function normalizeGapDays(value) {
    const candidate = isRecord(value) ? value.days : value;
    return Number.isInteger(candidate) && candidate >= 0 && candidate <= 36500
      ? candidate
      : null;
  }

  function normalizeSweepNarrative(value) {
    if (typeof value === "string") {
      return {
        summary: boundedString(value, 320),
        at: "",
        source: "",
        actor: ""
      };
    }
    const source = record(value);
    return {
      summary: boundedString(
        source.summary || source.label || source.reason || source.description,
        320
      ),
      at: boundedString(source.at || source.occurredAt || source.timestamp, 40),
      source: boundedString(source.source || source.provider, 64),
      actor: boundedString(source.actor || source.owner, 96)
    };
  }

  function normalizeSweepEvidenceHealth(value, eventSummary) {
    if (typeof value === "string") {
      return {
        status: boundedString(value, 64),
        summary: ""
      };
    }
    const source = record(value);
    const events = record(eventSummary);
    const sourceSummary = [
      sweepSourceListSummary("Fresh", source.freshSources),
      sweepSourceListSummary("Partial", source.partialSources),
      sweepSourceListSummary("Stale", source.staleSources),
      sweepSourceListSummary("Unavailable", source.unavailableSources)
    ].filter(Boolean).join(" · ");
    return {
      status: boundedString(
        source.status || source.completeness || source.state,
        64
      ),
      summary: boundedString(
        source.summary || source.message || events.summary || sourceSummary,
        240
      )
    };
  }

  function sweepSourceListSummary(label, value) {
    if (!Array.isArray(value) || !value.length) return "";
    return label + ": " + value.slice(0, 8).map(function (source) {
      return sweepSourceLabel(source);
    }).filter(Boolean).join(", ");
  }

  function normalizeSweepEventSummary(value) {
    const source = record(value);
    const normalized = {};
    [
      "fetchedEventCount",
      "acceptedEventCount",
      "ignoredUnfreshEventCount",
      "communicationActivityCount",
      "operationalActivityCount",
      "noiseCount",
      "unsupportedEventCount"
    ].forEach(function (key) {
      normalized[key] = Number.isInteger(source[key]) && source[key] >= 0
        ? source[key]
        : null;
    });
    return normalized;
  }

  function normalizeSweepSourceHealth(value) {
    const entries = [];
    if (Array.isArray(value)) {
      value.slice(0, 16).forEach(function (candidate, index) {
        const source = record(candidate);
        entries.push({
          key: boundedString(source.key || source.source || "source_" + String(index + 1), 64),
          label: boundedString(source.label || source.source || source.key, 96),
          status: boundedString(source.status || source.state, 64),
          detail: boundedString(source.detail || source.summary || source.message, 200)
        });
      });
      return entries;
    }

    const sources = record(value);
    Object.keys(sources).slice(0, 16).forEach(function (key) {
      const candidate = sources[key];
      const source = isRecord(candidate) ? candidate : {};
      entries.push({
        key: boundedString(key, 64),
        label: boundedString(source.label || sweepSourceLabel(key), 96),
        status: boundedString(
          typeof candidate === "string"
            ? candidate
            : source.status || source.state,
          64
        ),
        detail: boundedString(source.detail || source.summary || source.message, 200)
      });
    });
    return entries;
  }

  function normalizeSweepCompleteness(value, summaryValue, criteriaValue) {
    if (typeof value === "string") {
      return { status: boundedString(value, 64), summary: "" };
    }
    const source = record(value);
    const summary = record(summaryValue);
    const criteria = record(criteriaValue);
    const evidence = record(summary.evidence);
    const eligibleCount = Number.isInteger(summary.eligibleFileCount)
      && summary.eligibleFileCount >= 0
      ? summary.eligibleFileCount
      : null;
    const completeFiles = Number.isInteger(evidence.completeFiles)
      && evidence.completeFiles >= 0
      ? evidence.completeFiles
      : null;
    const partialFiles = Number.isInteger(evidence.partialFiles)
      && evidence.partialFiles >= 0
      ? evidence.partialFiles
      : null;
    const insufficientFiles = Number.isInteger(evidence.insufficientFiles)
      && evidence.insufficientFiles >= 0
      ? evidence.insufficientFiles
      : null;
    const summarizedStatus = insufficientFiles !== null && insufficientFiles > 0
      ? (
          eligibleCount !== null && insufficientFiles === eligibleCount
            ? "insufficient"
            : "partial"
        )
      : partialFiles !== null && partialFiles > 0
        ? "partial"
        : eligibleCount !== null
          && completeFiles !== null
          && completeFiles === eligibleCount
          ? "complete"
          : "";
    const countSummary = [
      completeFiles === null ? "" : String(completeFiles) + " complete",
      partialFiles === null ? "" : String(partialFiles) + " partial",
      insufficientFiles === null ? "" : String(insufficientFiles) + " insufficient"
    ].filter(Boolean).join(" · ");
    return {
      status: boundedString(
        source.status
          || source.state
          || summary.completenessStatus
          || summarizedStatus
          || (
          source.complete === true ? "complete" : source.complete === false ? "partial" : ""
          ),
        64
      ),
      summary: boundedString(
        source.summary
          || source.message
          || countSummary
          || (
            criteria.rankingMode === "activity_only"
              ? "Ranking mode: JobNimbus activity only."
              : ""
          ),
        240
      )
    };
  }

  function normalizeSweepExclusions(value) {
    if (Array.isArray(value)) {
      const grouped = new Map();
      value.forEach(function (candidate) {
        const exclusion = record(candidate);
        const rawLabel = typeof candidate === "string"
          ? candidate
          : exclusion.label
            || exclusion.reason
            || exclusion.reasonCode
            || exclusion.code;
        const label = boundedString(rawLabel, 160);
        if (!label) return;
        const existing = grouped.get(label) || {
          label: label,
          count: 0,
          detail: ""
        };
        existing.count += Number.isInteger(exclusion.count)
          && exclusion.count >= 0
          ? exclusion.count
          : 1;
        if (!existing.detail) {
          existing.detail = boundedString(
            exclusion.detail || exclusion.summary,
            240
          );
        }
        grouped.set(label, existing);
      });
      return Array.from(grouped.values()).slice(0, 32);
    }

    return Object.keys(record(value)).slice(0, 32).map(function (key) {
      const candidate = value[key];
      const exclusion = isRecord(candidate) ? candidate : {};
      return {
        label: boundedString(exclusion.label || humanize(key), 160),
        count: Number.isInteger(candidate)
          ? candidate
          : Number.isInteger(exclusion.count)
            ? exclusion.count
            : null,
        detail: boundedString(exclusion.detail || exclusion.summary, 240)
      };
    });
  }

  function renderManagementSweep(sweep) {
    const adjusterFileCount = sweep.adjusters.reduce(function (total, adjuster) {
      return total + adjuster.items.length;
    }, 0);
    const completenessTone = sweepCompletenessTone(sweep.completeness.status);
    const completenessLabel = completenessTone === "good"
      ? "JobNimbus complete"
      : completenessTone === "bad"
        ? "JobNimbus unavailable"
        : "JobNimbus limited";
    const generatedAt = readableDateTime(sweep.generatedAt);

    setText(elements["management-sweep-adjuster-count"], String(sweep.adjusters.length));
    setText(elements["management-sweep-file-count"], String(adjusterFileCount));
    setText(elements["management-sweep-completeness"], completenessLabel);
    setText(
      elements["management-sweep-generated"],
      generatedAt
        ? "Fresh report generated " + generatedAt + "."
        : "Fresh report received; generation time was not reported."
    );
    setText(elements["management-sweep-status"], "Report ready");
    setText(
      elements["management-sweep-hero-message"],
      adjusterFileCount
        ? adjusterFileCount + " ranked file" + (adjusterFileCount === 1 ? "" : "s")
          + " across " + sweep.adjusters.length + " adjuster"
          + (sweep.adjusters.length === 1 ? "" : "s") + "."
        : "The fresh report contains no eligible files."
    );
    badge(
      elements["management-sweep-section-status"],
      completenessTone === "good" ? "JobNimbus report ready" : "JobNimbus data limited",
      completenessTone
    );
    notice(
      elements["management-sweep-alert"],
      (
        completenessTone === "good"
          ? "The JobNimbus activity sweep completed. "
          : "The JobNimbus activity sweep is partial or unavailable. "
      )
        + "Company-wide Gmail, Quo, and calendar communication evidence was not checked, so communication gaps remain unverified."
        + (
          sweep.completeness.summary
            ? " JobNimbus detail: " + sweep.completeness.summary
            : ""
        ),
      completenessTone === "good" ? "warn" : completenessTone
    );

    renderSweepSourceHealth(sweep.sourceHealth);
    renderCompanyWorst(sweep.companyWorst);
    renderAdjusterSweeps(sweep.adjusters);
    renderSweepExclusions(sweep.exclusions);
  }

  function renderSweepSourceHealth(sources) {
    if (!sources.length) {
      elements["management-sweep-source-health"].replaceChildren();
      return;
    }
    const fragment = document.createDocumentFragment();
    sources.forEach(function (source) {
      const item = document.createElement("span");
      const dot = document.createElement("span");
      const copy = document.createElement("span");
      const status = source.status || "unknown";
      item.className = "sweep-source";
      item.dataset.tone = sweepCompletenessTone(status);
      item.title = source.detail || "";
      dot.className = "sweep-source-dot";
      dot.setAttribute("aria-hidden", "true");
      setText(
        copy,
        (
          SWEEP_SOURCE_LABELS[String(source.key || "").toLowerCase()]
          || source.label
          || humanize(source.key)
        ) + " · " + humanize(status)
      );
      item.append(dot, copy);
      fragment.append(item);
    });
    elements["management-sweep-source-health"].replaceChildren(fragment);
  }

  function renderCompanyWorst(items) {
    setText(elements["company-worst-count"], String(items.length));
    if (!items.length) {
      renderWorkspaceEmpty(
        elements["company-worst-list"],
        "No company-wide attention gaps were returned."
      );
      return;
    }
    const fragment = document.createDocumentFragment();
    items.forEach(function (item) {
      fragment.append(createSweepItem(item, { compact: true }));
    });
    elements["company-worst-list"].replaceChildren(fragment);
  }

  function renderAdjusterSweeps(adjusters) {
    if (!adjusters.length) {
      renderWorkspaceEmpty(
        elements["adjuster-sweep-list"],
        "No eligible adjuster groups were returned."
      );
      return;
    }

    const fragment = document.createDocumentFragment();
    adjusters.forEach(function (adjuster) {
      const group = document.createElement("section");
      const heading = document.createElement("div");
      const titleWrap = document.createElement("div");
      const kicker = document.createElement("span");
      const title = document.createElement("h4");
      const count = document.createElement("span");
      const list = document.createElement("div");

      group.className = "adjuster-sweep";
      heading.className = "adjuster-sweep-heading";
      kicker.className = "adjuster-sweep-kicker";
      title.className = "adjuster-sweep-name";
      count.className = "queue-count";
      list.className = "sweep-file-list";
      setText(kicker, "Assigned adjuster");
      setText(title, adjuster.name || "Adjuster");
      setText(
        count,
        String(adjuster.items.length) + " / " + String(adjuster.requestedCount)
      );
      titleWrap.append(kicker, title);
      heading.append(titleWrap, count);
      group.append(heading);

      if (!adjuster.items.length) {
        renderWorkspaceEmpty(list, "No eligible files were returned for this adjuster.");
      } else {
        const itemFragment = document.createDocumentFragment();
        adjuster.items.forEach(function (item) {
          itemFragment.append(createSweepItem(item, { compact: false }));
        });
        list.replaceChildren(itemFragment);
      }
      group.append(list);
      if (adjuster.shortage.isShort) {
        const shortage = document.createElement("p");
        shortage.className = "adjuster-shortage";
        setText(
          shortage,
          String(adjuster.shortage.missingCount) + " slot"
            + (adjuster.shortage.missingCount === 1 ? "" : "s")
            + " unfilled"
            + (
              adjuster.shortage.reasonCode
                ? " · " + humanize(adjuster.shortage.reasonCode)
                : ""
            )
            + "."
        );
        group.append(shortage);
      }
      fragment.append(group);
    });
    elements["adjuster-sweep-list"].replaceChildren(fragment);
  }

  function createSweepItem(item, options) {
    const article = document.createElement("article");
    const heading = document.createElement("div");
    const rank = document.createElement("span");
    const identity = document.createElement("div");
    const title = document.createElement("strong");
    const meta = document.createElement("span");
    const primaryGap = document.createElement("div");
    const primaryDays = document.createElement("strong");
    const primaryLabel = document.createElement("span");
    const gapList = document.createElement("div");
    const riskList = document.createElement("div");
    const details = document.createElement("dl");
    const largestGap = item.gaps.reduce(function (largest, gap) {
      if (gap.days === null || gap.available === false) return largest;
      return !largest || gap.days > largest.days ? gap : largest;
    }, null);
    const primaryGapDays = item.attention.days !== null
      ? item.attention.days
      : largestGap
        ? largestGap.days
        : null;

    article.className = "sweep-file";
    if (options && options.compact) article.classList.add("is-compact");
    heading.className = "sweep-file-heading";
    rank.className = "sweep-rank";
    identity.className = "sweep-identity";
    title.className = "sweep-file-name";
    meta.className = "sweep-file-meta";
    primaryGap.className = "sweep-primary-gap";
    primaryDays.className = "sweep-primary-days";
    primaryLabel.className = "sweep-primary-label";
    gapList.className = "sweep-gap-list";
    riskList.className = "sweep-risk-list";
    details.className = "sweep-detail-list";

    setText(rank, String(item.rank).padStart(2, "0"));
    setText(title, item.displayName || item.jobNumber || "Exact file");
    setText(
      meta,
      [item.jobNumber, item.status].filter(Boolean).join(" · ") || "Status not reported"
    );
    setText(primaryDays, primaryGapDays === null ? "—" : String(primaryGapDays));
    setText(
      primaryLabel,
      item.attention.days !== null
        ? "Unresolved JobNimbus gap · days"
        : largestGap
          ? largestGap.label + " · days"
          : "Gap not reported"
    );
    identity.append(title, meta);
    primaryGap.append(primaryDays, primaryLabel);
    heading.append(rank, identity, primaryGap);
    article.append(heading);

    item.gaps.forEach(function (gap) {
      const chip = document.createElement("span");
      const value = document.createElement("strong");
      const label = document.createElement("span");
      if (gap.available === false || gap.days === null) {
        chip.dataset.tone = "unavailable";
        setText(value, "N/A");
      } else {
        setText(value, String(gap.days) + "d");
      }
      setText(label, gap.label);
      chip.append(value, label);
      gapList.append(chip);
    });
    if (item.gaps.length) article.append(gapList);

    item.riskFlags.forEach(function (flag) {
      const badgeItem = document.createElement("span");
      badgeItem.className = "sweep-risk";
      setText(badgeItem, humanize(flag));
      riskList.append(badgeItem);
    });
    if (item.evidenceHealth.status) {
      const health = document.createElement("span");
      health.className = "sweep-risk";
      health.dataset.tone = sweepCompletenessTone(item.evidenceHealth.status);
      setText(health, "Evidence · " + humanize(item.evidenceHealth.status));
      riskList.append(health);
    }
    if (riskList.childNodes.length) article.append(riskList);

    appendSweepDetail(
      details,
      "Last JobNimbus touch",
      sweepNarrativeText(item.lastTouch)
    );
    appendSweepDetail(details, "Current blocker", item.blocker.summary);
    appendSweepDetail(details, "Recommended next", item.nextAction.summary);
    if (item.evidenceHealth.summary) {
      appendSweepDetail(details, "Evidence note", item.evidenceHealth.summary);
    }
    appendSweepDetail(
      details,
      "JobNimbus event summary",
      sweepEventSummaryText(item.eventSummary)
    );
    if (details.childNodes.length) article.append(details);

    const matchingFile = record(state.workCenter).files?.find(function (file) {
      return file.fileRef === item.fileRef;
    });
    if (matchingFile) {
      const action = document.createElement("button");
      action.type = "button";
      action.className = "sweep-open-file";
      setText(action, "Open exact file");
      action.addEventListener("click", function () {
        loadFileReview(item.fileRef);
        document.getElementById("work-center").scrollIntoView({ block: "start" });
      });
      article.append(action);
    }

    return article;
  }

  function appendSweepDetail(container, labelValue, contentValue) {
    if (!contentValue) return;
    const group = document.createElement("div");
    const label = document.createElement("dt");
    const content = document.createElement("dd");
    setText(label, labelValue);
    setText(content, contentValue);
    group.append(label, content);
    container.append(group);
  }

  function sweepNarrativeText(narrative) {
    const parts = [];
    if (narrative.summary) parts.push(narrative.summary);
    if (narrative.at) parts.push(readableDateTime(narrative.at));
    if (narrative.source) parts.push(sweepSourceLabel(narrative.source));
    if (narrative.actor) parts.push(narrative.actor);
    return parts.filter(Boolean).join(" · ");
  }

  function sweepEventSummaryText(summary) {
    const parts = [];
    if (summary.fetchedEventCount !== null) {
      parts.push(String(summary.fetchedEventCount) + " fetched");
    }
    if (summary.acceptedEventCount !== null) {
      parts.push(String(summary.acceptedEventCount) + " allowlisted");
    }
    if (
      summary.communicationActivityCount !== null
      && summary.communicationActivityCount > 0
    ) {
      parts.push(
        String(summary.communicationActivityCount)
        + " communication activit"
        + (summary.communicationActivityCount === 1 ? "y" : "ies")
      );
    }
    if (summary.operationalActivityCount !== null) {
      parts.push(String(summary.operationalActivityCount) + " operational");
    }
    if (summary.noiseCount !== null) {
      parts.push(String(summary.noiseCount) + " noise excluded");
    }
    if (
      summary.unsupportedEventCount !== null
      && summary.unsupportedEventCount > 0
    ) {
      parts.push(
        String(summary.unsupportedEventCount)
        + " unsupported excluded"
      );
    }
    if (
      summary.ignoredUnfreshEventCount !== null
      && summary.ignoredUnfreshEventCount > 0
    ) {
      parts.push(
        String(summary.ignoredUnfreshEventCount) + " ignored from unfresh evidence"
      );
    }
    return parts.join(" · ");
  }

  function renderSweepExclusions(exclusions) {
    const excludedFileCount = exclusions.reduce(function (total, exclusion) {
      return total + (
        Number.isInteger(exclusion.count) && exclusion.count >= 0
          ? exclusion.count
          : 0
      );
    }, 0);
    setText(
      elements["management-sweep-exclusion-count"],
      String(excludedFileCount || exclusions.length)
    );
    elements["management-sweep-exclusions"].hidden = exclusions.length === 0;
    if (!exclusions.length) {
      elements["management-sweep-exclusion-list"].replaceChildren();
      return;
    }
    const fragment = document.createDocumentFragment();
    exclusions.forEach(function (exclusion) {
      const item = document.createElement("div");
      const label = document.createElement("strong");
      const detail = document.createElement("span");
      setText(
        label,
        humanize(exclusion.label) + (
          exclusion.count === null ? "" : " · " + String(exclusion.count)
        )
      );
      setText(detail, exclusion.detail || "Excluded by the report’s eligibility rules.");
      item.append(label, detail);
      fragment.append(item);
    });
    elements["management-sweep-exclusion-list"].replaceChildren(fragment);
  }

  function sweepCompletenessTone(status) {
    const normalized = String(status || "").toLowerCase();
    if (
      normalized === "complete"
      || normalized === "available"
      || normalized === "fresh"
      || normalized === "ok"
      || normalized === "good"
    ) return "good";
    if (
      normalized === "partial"
      || normalized === "stale"
      || normalized === "limited"
      || normalized === "unknown"
    ) return "warn";
    if (
      normalized === "unavailable"
      || normalized === "insufficient"
      || normalized === "failed"
      || normalized === "error"
      || normalized === "bad"
    ) return "bad";
    return "neutral";
  }

  async function loadWorkCenter(options) {
    const resetFile = !options || options.resetFile !== false;
    const optionOffset = options && Number(options.offset);
    const requestedOffset = Number.isInteger(optionOffset)
      && optionOffset >= 0
      && optionOffset <= 5000
      ? optionOffset
      : state.workCenterOffset;
    if (!hasWorkCenterAuthority()) {
      syncOperationalAccess();
      return;
    }
    if (!navigator.onLine) {
      clearOperationalData("Reconnect to request a fresh Work Center.");
      syncOperationalAccess();
      return;
    }

    if (state.workCenterController) state.workCenterController.abort();
    const controller = new AbortController();
    state.workCenterController = controller;
    state.workCenterLoading = true;
    state.workCenter = null;
    state.workCenterOffset = requestedOffset;
    syncHomeGuidance();
    if (resetFile) {
      state.selectedFileRef = null;
      state.fileReview = null;
      closeFileReview();
    }

    elements["work-center-list"].setAttribute("aria-busy", "true");
    elements["work-center-refresh"].disabled = true;
    elements["work-center-previous"].disabled = true;
    elements["work-center-next"].disabled = true;
    elements["work-center-previous"].hidden = requestedOffset === 0;
    elements["work-center-next"].hidden = true;
    setText(
      elements["work-center-page"],
      "Loading page " + (Math.floor(requestedOffset / WORK_CENTER_PAGE_SIZE) + 1)
    );
    badge(elements["work-center-status"], "Loading", "neutral");
    notice(
      elements["work-center-alert"],
      "Checking your current assigned JobNimbus queue.",
      "neutral"
    );
    renderWorkspaceEmpty(elements["work-center-list"], "Loading fresh assigned files…");

    try {
      const response = await postOperationalJson(
        ENDPOINTS.workCenter,
        { offset: requestedOffset, limit: WORK_CENTER_PAGE_SIZE },
        controller.signal,
        WORK_CENTER_CAPABILITY
      );
      if (controller.signal.aborted) return;
      state.workCenter = normalizeWorkCenterResponse(response, requestedOffset);
      state.workCenterOffset = state.workCenter.page.offset;
      renderWorkCenter(state.workCenter);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (isAuthorizationStatus(error)) {
        handleOperationalAuthLoss();
        return;
      }
      state.workCenter = null;
      badge(elements["work-center-status"], "Unavailable", "bad");
      notice(
        elements["work-center-alert"],
        workCenterErrorMessage(error),
        "bad"
      );
      renderWorkspaceEmpty(
        elements["work-center-list"],
        "The fresh assigned-file queue could not be loaded."
      );
      setText(elements["work-center-count"], "—");
      setText(
        elements["work-center-page"],
        "Page " + (Math.floor(requestedOffset / WORK_CENTER_PAGE_SIZE) + 1) +
          " unavailable"
      );
      setText(
        elements["work-center-freshness"],
        requestedOffset
          ? "No stale page is shown. Return to the previous page or refresh the queue."
          : "No stale queue is shown."
      );
    } finally {
      if (state.workCenterController === controller) {
        state.workCenterController = null;
        state.workCenterLoading = false;
        elements["work-center-list"].setAttribute("aria-busy", "false");
        elements["work-center-refresh"].disabled = false;
        elements["work-center-previous"].disabled = false;
        elements["work-center-next"].disabled = false;
        syncHomeGuidance();
      }
    }
  }

  function normalizeWorkCenterResponse(value, expectedOffset) {
    if (
      value.schema !== "hcn.console.work-center.v1" ||
      value.ephemeral !== true ||
      value.cachePolicy !== "no_store" ||
      !Array.isArray(value.files)
    ) {
      throw new Error("Invalid Work Center response");
    }

    const page = record(value.page);
    if (
      !Number.isInteger(page.offset) ||
      !Number.isInteger(page.limit) ||
      !Number.isInteger(page.total) ||
      page.offset !== expectedOffset ||
      page.offset < 0 ||
      page.offset > 5000 ||
      page.limit !== WORK_CENTER_PAGE_SIZE ||
      page.total < 0 ||
      typeof page.hasMore !== "boolean" ||
      value.files.length > page.limit ||
      (
        page.offset > page.total
        ? value.files.length !== 0
        : page.offset + value.files.length > page.total
      ) ||
      page.hasMore !== (page.offset + value.files.length < page.total)
    ) {
      throw new Error("Invalid Work Center page");
    }

    const files = value.files.map(function (candidate) {
      const file = record(candidate);
      const fileRef = boundedString(file.fileRef, 80);
      if (!FILE_REF.test(fileRef)) throw new Error("Invalid file reference");
      const attentionCodes = Array.isArray(file.attentionCodes)
        ? file.attentionCodes.slice(0, 8).map(function (code) {
            return boundedString(code, 64);
          }).filter(Boolean)
        : [];
      const missing = record(file.missing);
      return {
        fileRef: fileRef,
        jobNumber: boundedString(file.jobNumber, 64),
        displayName: boundedString(file.displayName, 80),
        statusCode: boundedString(file.statusCode, 64),
        stageCode: boundedString(file.stageCode, 64),
        fileTypeCode: boundedString(file.fileTypeCode, 64),
        updatedAt: boundedString(file.updatedAt, 40),
        lane: boundedString(file.lane, 32),
        attentionCodes: attentionCodes,
        missing: {
          claimNumber: missing.claimNumber === true,
          policyNumber: missing.policyNumber === true,
          dateOfLoss: missing.dateOfLoss === true,
          adjuster: missing.adjuster === true
        }
      };
    });

    return {
      generatedAt: boundedString(value.generatedAt, 40),
      source: normalizeSourceSummary(value.source, "jobnimbus"),
      page: {
        offset: page.offset,
        limit: page.limit,
        total: page.total,
        hasMore: page.hasMore === true
      },
      files: files
    };
  }

  function renderWorkCenter(workCenter) {
    const files = workCenter.files;
    const total = workCenter.page.total;
    const offset = workCenter.page.offset;
    const first = files.length ? offset + 1 : 0;
    const last = offset + files.length;
    const pageNumber = Math.floor(offset / workCenter.page.limit) + 1;
    const pageCount = Math.max(
      pageNumber,
      Math.ceil(total / workCenter.page.limit),
      1
    );
    setText(
      elements["work-center-count"],
      files.length ? first + "–" + last + " / " + total : "0 / " + total
    );
    setText(
      elements["work-center-page"],
      "Page " + pageNumber + " of " + pageCount
    );
    elements["work-center-previous"].hidden = offset === 0;
    elements["work-center-next"].hidden = !workCenter.page.hasMore;
    setText(
      elements["work-center-freshness"],
      "Fresh JobNimbus check " + readableDateTime(workCenter.generatedAt) +
        (files.length ? " · showing files " + first + "–" + last + "." : ".")
    );
    badge(elements["work-center-status"], "Fresh · read only", "good");
    notice(
      elements["work-center-alert"],
      files.length
        ? "Assigned files " + first + "–" + last + " are ready for exact review."
        : offset
          ? "No assigned files remain on this page."
          : "The fresh assigned-file queue is empty.",
      "good"
    );

    if (!files.length) {
      renderWorkspaceEmpty(
        elements["work-center-list"],
        offset
          ? "No files remain on this page. Return to the previous page or refresh the queue."
          : "No active insurance files are currently assigned to you."
      );
      refreshManagementSweepFileLinks();
      return;
    }

    const fragment = document.createDocumentFragment();
    files.forEach(function (file) {
      fragment.append(createWorkFileButton(file));
    });
    elements["work-center-list"].replaceChildren(fragment);
    refreshManagementSweepFileLinks();
  }

  function refreshManagementSweepFileLinks() {
    if (!state.managementSweep) return;
    renderCompanyWorst(state.managementSweep.companyWorst);
    renderAdjusterSweeps(state.managementSweep.adjusters);
  }

  function createWorkFileButton(file) {
    const button = document.createElement("button");
    const top = document.createElement("span");
    const name = document.createElement("span");
    const number = document.createElement("span");
    const meta = document.createElement("span");
    const status = document.createElement("span");
    const stage = document.createElement("span");
    const badges = document.createElement("span");

    button.type = "button";
    button.className = "work-file";
    button.setAttribute("aria-pressed", file.fileRef === state.selectedFileRef ? "true" : "false");
    if (file.fileRef === state.selectedFileRef) button.classList.add("is-selected");
    top.className = "work-file-top";
    name.className = "work-file-name";
    number.className = "work-file-number";
    meta.className = "work-file-meta";
    badges.className = "work-file-badges";

    setText(name, file.displayName || "Unnamed assigned file");
    setText(number, file.jobNumber || "No job number");
    setText(status, humanize(file.statusCode || "status unavailable"));
    setText(stage, humanize(file.stageCode || "stage unavailable"));
    top.append(name, number);
    meta.append(status, stage);

    if (file.attentionCodes.length) {
      file.attentionCodes.forEach(function (code) {
        const item = document.createElement("span");
        item.className = "attention-badge";
        setText(item, ATTENTION_LABELS[code] || humanize(code));
        badges.append(item);
      });
    } else {
      const active = document.createElement("span");
      active.className = "attention-badge";
      active.dataset.tone = "active";
      setText(active, "Active");
      badges.append(active);
    }

    button.append(top, meta, badges);
    button.addEventListener("click", function () {
      loadFileReview(file.fileRef);
    });
    return button;
  }

  async function loadFileReview(fileRef) {
    if (!hasFileReviewAuthority() || !FILE_REF.test(String(fileRef || ""))) {
      notice(
        elements["work-center-alert"],
        "This session cannot open exact file evidence.",
        "bad"
      );
      return;
    }
    const selected = record(state.workCenter).files?.find(function (file) {
      return file.fileRef === fileRef;
    });
    if (!selected) {
      notice(
        elements["work-center-alert"],
        "Refresh the queue before opening that file.",
        "warn"
      );
      return;
    }
    if (!navigator.onLine) {
      clearOperationalData("Client data was cleared when the connection went offline.");
      syncOperationalAccess();
      return;
    }

    if (state.fileController) state.fileController.abort();
    const controller = new AbortController();
    state.fileController = controller;
    state.fileLoading = true;
    state.selectedFileRef = fileRef;
    state.fileReview = null;
    renderWorkCenter(state.workCenter);
    openFileLoading(selected);

    try {
      const response = await postOperationalJson(
        ENDPOINTS.fileReview,
        { fileRef: fileRef, recentLimit: 20 },
        controller.signal,
        FILE_REVIEW_CAPABILITY
      );
      if (controller.signal.aborted) return;
      state.fileReview = normalizeFileResponse(response, fileRef);
      renderFileReview(state.fileReview);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (isAuthorizationStatus(error)) {
        handleOperationalAuthLoss();
        return;
      }
      state.fileReview = null;
      badge(elements["file-evidence-status"], "Unavailable", "bad");
      notice(
        elements["file-alert"],
        fileErrorMessage(error),
        "bad"
      );
      resetFileEvidenceContainers(
        "Fresh file evidence could not be loaded. No earlier file detail is shown."
      );
    } finally {
      if (state.fileController === controller) {
        state.fileController = null;
        state.fileLoading = false;
        elements["file-refresh"].disabled = false;
      }
    }
  }

  function openFileLoading(selected) {
    resetActionComposerForFile(
      "Waiting for fresh file evidence before actions can be prepared."
    );
    elements["work-center-workspace"].dataset.fileOpen = "true";
    elements["file-placeholder"].hidden = true;
    elements["file-review"].hidden = false;
    elements["file-refresh"].disabled = true;
    setText(elements["file-job-number"], selected.jobNumber || "Exact file");
    setText(elements["file-name"], selected.displayName || "Assigned file");
    setText(
      elements["file-stage"],
      humanize(selected.statusCode || "status unavailable") + " · " +
        humanize(selected.stageCode || "stage unavailable")
    );
    badge(elements["file-evidence-status"], "Checking", "neutral");
    notice(
      elements["file-alert"],
      "Loading fresh JobNimbus, Gmail, and Quo evidence for this exact file.",
      "neutral"
    );
    setText(elements["file-freshness"], "Checking now");
    resetFileEvidenceContainers("Loading fresh evidence…");
    if (window.matchMedia("(max-width: 620px)").matches) {
      elements["file-review"].scrollIntoView({ block: "start" });
    }
  }

  function closeFileReview() {
    if (state.fileController) state.fileController.abort();
    state.fileController = null;
    state.fileLoading = false;
    state.selectedFileRef = null;
    state.fileReview = null;
    elements["work-center-workspace"].removeAttribute("data-file-open");
    elements["file-placeholder"].hidden = false;
    elements["file-review"].hidden = true;
    elements["file-refresh"].disabled = false;
    purgeFileReviewDom();
    resetActionComposerForFile("Choose one exact file before preparing actions.");
    if (state.workCenter) renderWorkCenter(state.workCenter);
  }

  function purgeFileReviewDom() {
    setText(elements["file-job-number"], "No file selected");
    setText(elements["file-name"], "Choose a file from the fresh queue");
    setText(elements["file-stage"], "No client data is retained");
    badge(elements["file-evidence-status"], "Not loaded", "neutral");
    notice(
      elements["file-alert"],
      "Open one exact file to request fresh evidence.",
      "neutral"
    );
    setText(elements["file-freshness"], "No evidence loaded");
    resetFileEvidenceContainers("No client data is retained.");
  }

  function normalizeFileResponse(value, expectedFileRef) {
    if (
      value.schema !== "hcn.console.file.v1" ||
      value.ephemeral !== true ||
      value.cachePolicy !== "no_store"
    ) {
      throw new Error("Invalid file response");
    }
    const sourceFile = record(value.file);
    const fileRef = boundedString(sourceFile.fileRef, 80);
    if (fileRef !== expectedFileRef || !FILE_REF.test(fileRef)) {
      throw new Error("File response did not match the selected file");
    }

    const client = record(sourceFile.client);
    const property = record(sourceFile.property);
    const insurance = record(sourceFile.insurance);
    const adjuster = record(sourceFile.adjuster);
    const missing = record(sourceFile.missing);
    const sources = record(value.sources);
    const lanes = record(value.lanes);
    const recent = record(value.recent);
    const intelligence = normalizeFileIntelligence(
      value.intelligence,
      fileRef
    );

    return {
      generatedAt: boundedString(value.generatedAt, 40),
      evidenceStatus: boundedString(value.evidenceStatus, 32),
      file: {
        fileRef: fileRef,
        jobNumber: boundedString(sourceFile.jobNumber, 64),
        displayName: boundedString(sourceFile.displayName, 120),
        statusCode: boundedString(sourceFile.statusCode, 64),
        stageCode: boundedString(sourceFile.stageCode, 64),
        fileTypeCode: boundedString(sourceFile.fileTypeCode, 64),
        updatedAt: boundedString(sourceFile.updatedAt, 40),
        nextAppointmentAt: boundedString(sourceFile.nextAppointmentAt, 40),
        client: {
          primaryEmail: boundedString(client.primaryEmail, 254),
          primaryPhone: boundedString(client.primaryPhone, 64)
        },
        property: {
          address: boundedString(property.address, 180)
        },
        insurance: {
          carrierName: boundedString(insurance.carrierName, 120),
          claimNumber: boundedString(insurance.claimNumber, 80),
          policyNumber: boundedString(insurance.policyNumber, 80),
          dateOfLoss: boundedString(insurance.dateOfLoss, 10)
        },
        adjuster: {
          name: boundedString(adjuster.name, 120),
          email: boundedString(adjuster.email, 254),
          phone: boundedString(adjuster.phone, 64)
        },
        missing: {
          claimNumber: missing.claimNumber === true,
          policyNumber: missing.policyNumber === true,
          dateOfLoss: missing.dateOfLoss === true,
          adjuster: missing.adjuster === true
        }
      },
      sources: {
        jobnimbus: normalizeSourceSummary(sources.jobnimbus, "jobnimbus"),
        gmail: normalizeSourceSummary(sources.gmail, "gmail"),
        quo: normalizeSourceSummary(sources.quo, "quo")
      },
      lanes: {
        priority: normalizeLaneItems(lanes.priority),
        today: normalizeLaneItems(lanes.today),
        waiting: normalizeLaneItems(lanes.waiting)
      },
      recent: {
        activities: normalizeRecentItems(recent.activities, "activity"),
        tasks: normalizeRecentItems(recent.tasks, "task"),
        documents: normalizeRecentItems(recent.documents, "document"),
        gmail: normalizeRecentItems(recent.gmail, "gmail"),
        quo: normalizeRecentItems(recent.quo, "quo")
      },
      intelligence: intelligence
    };
  }

  function normalizeFileIntelligence(value, expectedFileRef) {
    const intelligence = record(value);
    if (
      intelligence.schemaVersion !== "hcn.ops.file-intelligence.v1" ||
      intelligence.fileRef !== expectedFileRef
    ) {
      throw new Error("Invalid deterministic file intelligence");
    }
    const stage = record(intelligence.currentStage);
    const urgency = record(intelligence.urgency);
    const confidence = record(intelligence.confidence);
    const completeness = record(intelligence.sourceCompleteness);
    const workflowSource = record(intelligence.workflows);
    const workflowIds = [
      "neglected_files",
      "communications",
      "claim_filing",
      "inspection_scheduling",
      "follow_up"
    ];
    const workflows = {};
    workflowIds.forEach(function (workflowId) {
      const workflow = record(workflowSource[workflowId]);
      if (
        workflow.schemaVersion !== "hcn.ops.workflow-evaluation.v1" ||
        workflow.workflowId !== workflowId ||
        workflow.fileRef !== expectedFileRef
      ) {
        throw new Error("Invalid workflow intelligence");
      }
      workflows[workflowId] = {
        eligibility: boundedString(workflow.eligibility, 32),
        readiness: boundedString(workflow.readiness, 32),
        escalationFlags: normalizeCodeList(
          workflow.escalationFlags,
          16
        ),
        nextActions: normalizeIntelligenceActions(
          workflow.nextActions,
          12
        )
      };
    });
    return {
      currentStage: boundedString(stage.code, 64),
      urgency: {
        level: boundedString(urgency.level, 32),
        reasonCodes: normalizeCodeList(urgency.reasonCodes, 16)
      },
      confidence: {
        level: boundedString(confidence.level, 32),
        reasonCodes: normalizeCodeList(confidence.reasonCodes, 16)
      },
      sourceCompleteness: boundedString(
        completeness.status,
        32
      ),
      nextRequiredActions: normalizeIntelligenceActions(
        intelligence.nextRequiredActions,
        12
      ),
      workflows: workflows
    };
  }

  function normalizeIntelligenceActions(value, maximum) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, maximum).map(function (candidate) {
      const action = record(candidate);
      return {
        actionCode: boundedString(action.actionCode, 64),
        targetCode: boundedString(action.targetCode, 64),
        urgency: boundedString(action.urgency, 32),
        dueAt: boundedString(action.dueAt, 40),
        requiresApproval: action.requiresApproval === true
      };
    }).filter(function (action) {
      return Boolean(action.actionCode);
    });
  }

  function normalizeCodeList(value, maximum) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, maximum).map(function (code) {
      return boundedString(code, 64);
    }).filter(Boolean);
  }

  function normalizeSourceSummary(value, expectedSource) {
    const source = record(value);
    return {
      source: boundedString(source.source, 32) || expectedSource,
      status: boundedString(source.status, 32),
      completeness: boundedString(source.completeness, 32),
      failureCode: boundedString(source.failureCode, 64),
      checkedAt: boundedString(source.checkedAt, 40),
      validUntil: boundedString(source.validUntil, 40),
      acceptedItems: Number.isInteger(source.acceptedItems)
        ? Math.max(0, source.acceptedItems)
        : 0,
      droppedItems: Number.isInteger(source.droppedItems)
        ? Math.max(0, source.droppedItems)
        : 0
    };
  }

  function normalizeLaneItems(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 20).map(function (candidate) {
      const item = record(candidate);
      return {
        reasonCode: boundedString(item.reasonCode, 64),
        source: boundedString(item.source, 32),
        at: boundedString(item.at, 40)
      };
    }).filter(function (item) {
      return Boolean(item.reasonCode);
    });
  }

  function normalizeRecentItems(value, kind) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 20).map(function (candidate) {
      const item = record(candidate);
      const reference = boundedString(item.reference, 80);
      if (kind === "task" && !TASK_REF.test(reference)) {
        throw new Error("Invalid task reference");
      }
      const base = {
        category: kind,
        reference: reference,
        typeCode: boundedString(item.kind, 64),
        label: boundedString(item.label, 160),
        occurredAt: boundedString(item.occurredAt, 40),
        dueAt: boundedString(item.dueAt, 40),
        createdAt: boundedString(item.createdAt, 40),
        state: boundedString(item.state, 64),
        status: boundedString(item.status, 64),
        priority: boundedString(item.priority, 64),
        actorRole: boundedString(item.actorRole, 64),
        assignedRole: boundedString(item.assignedRole, 64),
        fileName: boundedString(item.fileName, 160),
        reviewState: boundedString(item.reviewState, 64),
        direction: boundedString(item.direction, 64),
        actionState: boundedString(item.actionState, 64),
        subject: boundedString(item.subject, 160),
        snippet: boundedString(item.snippet, 240),
        channel: boundedString(item.channel, 64),
        disposition: boundedString(item.disposition, 64),
        preview: boundedString(item.preview, 240),
        hasAttachment: item.hasAttachment === true
      };
      return base;
    });
  }

  function renderFileReview(review) {
    const file = review.file;
    setText(elements["file-job-number"], file.jobNumber || "Exact file");
    setText(elements["file-name"], file.displayName || "Assigned file");
    setText(
      elements["file-stage"],
      humanize(file.statusCode || "status unavailable") + " · " +
        humanize(file.stageCode || "stage unavailable")
    );
    const complete = review.evidenceStatus === "complete";
    badge(
      elements["file-evidence-status"],
      complete ? "Evidence complete" : "Evidence partial",
      complete ? "good" : "neutral"
    );
    notice(
      elements["file-alert"],
      complete
        ? "Fresh evidence is complete across JobNimbus, Gmail, and Quo."
        : "Fresh JobNimbus detail is available; one or more optional sources are incomplete.",
      complete ? "good" : "warn"
    );
    setText(
      elements["file-freshness"],
      review.generatedAt
        ? "Checked " + readableDateTime(review.generatedAt)
        : "Fresh check completed"
    );
    renderSourceHealth(review.sources);
    renderKeyFacts(file);
    renderFileIntelligence(review.intelligence);
    renderLane("priority", review.lanes.priority);
    renderLane("today", review.lanes.today);
    renderLane("waiting", review.lanes.waiting);
    renderRecentList(elements["recent-tasks"], review.recent.tasks, "tasks");
    renderRecentList(elements["recent-documents"], review.recent.documents, "documents");
    renderRecentList(elements["recent-gmail"], review.recent.gmail, "gmail");
    renderRecentList(elements["recent-quo"], review.recent.quo, "quo");
    renderRecentList(
      elements["recent-activities"],
      review.recent.activities,
      "activities"
    );
    populateTaskOptions(review.recent.tasks);
    populateEventOptions(review.recent.activities);
    renderActionComposerState();
  }

  function renderSourceHealth(sources) {
    const fragment = document.createDocumentFragment();
    ["jobnimbus", "gmail", "quo"].forEach(function (name) {
      const source = record(sources[name]);
      const complete = source.status === "fresh" &&
        source.completeness === "complete";
      const unavailable = source.completeness === "none" ||
        source.status === "incomplete" ||
        source.status === "failed";
      const item = document.createElement("article");
      const top = document.createElement("div");
      const title = document.createElement("strong");
      const dot = document.createElement("span");
      const detail = document.createElement("p");

      item.className = "source-health-item";
      item.dataset.tone = complete ? "good" : unavailable ? "bad" : "warn";
      top.className = "source-health-top";
      dot.className = "source-health-dot";
      dot.setAttribute("aria-hidden", "true");
      setText(title, name === "jobnimbus" ? "JobNimbus" : name === "gmail" ? "Gmail" : "Quo");
      setText(
        detail,
        complete
          ? source.acceptedItems + " recent item" +
            (source.acceptedItems === 1 ? "" : "s") + " accepted"
          : humanize(source.failureCode || source.completeness || "source incomplete")
      );
      top.append(title, dot);
      item.append(top, detail);
      fragment.append(item);
    });
    elements["source-health"].replaceChildren(fragment);
  }

  function renderKeyFacts(file) {
    const groups = [
      {
        title: "File",
        rows: [
          ["Job number", file.jobNumber],
          ["Status", humanize(file.statusCode)],
          ["Stage", humanize(file.stageCode)],
          ["Type", humanize(file.fileTypeCode)],
          ["Last updated", readableDateTime(file.updatedAt)]
        ]
      },
      {
        title: "Homeowner & property",
        rows: [
          ["Email", file.client.primaryEmail],
          ["Phone", file.client.primaryPhone],
          ["Property", file.property.address],
          ["Next appointment", readableDateTime(file.nextAppointmentAt)]
        ]
      },
      {
        title: "Insurance",
        rows: [
          ["Carrier", file.insurance.carrierName],
          ["Claim number", file.insurance.claimNumber, file.missing.claimNumber],
          ["Policy number", file.insurance.policyNumber, file.missing.policyNumber],
          ["Date of loss", file.insurance.dateOfLoss, file.missing.dateOfLoss],
          ["Adjuster", file.adjuster.name, file.missing.adjuster],
          ["Adjuster email", file.adjuster.email],
          ["Adjuster phone", file.adjuster.phone]
        ]
      }
    ];

    const fragment = document.createDocumentFragment();
    groups.forEach(function (group) {
      const article = document.createElement("article");
      const heading = document.createElement("h5");
      article.className = "fact-group";
      setText(heading, group.title);
      article.append(heading);
      group.rows.forEach(function (row) {
        const wrapper = document.createElement("div");
        const label = document.createElement("span");
        const value = document.createElement("strong");
        wrapper.className = "fact-row";
        setText(label, row[0]);
        setText(value, row[1] || "Not on fresh file");
        if (row[2] === true || !row[1]) value.dataset.missing = "true";
        wrapper.append(label, value);
        article.append(wrapper);
      });
      fragment.append(article);
    });
    elements["key-facts"].replaceChildren(fragment);
  }

  function renderFileIntelligence(intelligence) {
    const urgencyLevel = intelligence.urgency.level || "unknown";
    badge(
      elements["file-intelligence-urgency"],
      humanize(urgencyLevel) + " attention",
      urgencyLevel === "urgent"
        ? "bad"
        : urgencyLevel === "high"
          ? "warn"
          : urgencyLevel === "low"
            ? "good"
            : "neutral"
    );
    setText(
      elements["file-intelligence-summary"],
      "Operational stage: "
        + humanize(intelligence.currentStage || "unknown")
        + " · Confidence: "
        + humanize(intelligence.confidence.level || "unknown")
        + " · Source coverage: "
        + humanize(intelligence.sourceCompleteness || "unknown")
    );

    const workflowLabels = {
      neglected_files: "Neglected file",
      communications: "Communications",
      claim_filing: "Claim filing",
      inspection_scheduling: "Inspection",
      follow_up: "Follow-up"
    };
    const workflowFragment = document.createDocumentFragment();
    Object.keys(workflowLabels).forEach(function (workflowId) {
      const workflow = record(intelligence.workflows[workflowId]);
      const item = document.createElement("div");
      const label = document.createElement("strong");
      const status = document.createElement("span");
      item.className = "intelligence-workflow";
      item.dataset.tone =
        workflow.readiness === "ready"
          ? "good"
          : workflow.readiness === "blocked"
            ? "bad"
            : workflow.readiness === "partially_ready"
              ? "warn"
              : "neutral";
      setText(label, workflowLabels[workflowId]);
      setText(status, humanize(workflow.readiness || "unknown"));
      item.append(label, status);
      workflowFragment.append(item);
    });
    elements["file-intelligence-workflows"].replaceChildren(
      workflowFragment
    );

    const actions = intelligence.nextRequiredActions.slice(0, 6);
    if (!actions.length) {
      renderRecentEmpty(
        elements["file-intelligence-actions"],
        "No deterministic next step is currently proven by the fresh evidence."
      );
      return;
    }
    const actionFragment = document.createDocumentFragment();
    actions.forEach(function (action) {
      const item = document.createElement("div");
      const title = document.createElement("strong");
      const detail = document.createElement("span");
      item.className = "intelligence-action";
      setText(
        title,
        humanize(action.actionCode)
          + (action.targetCode
            ? ": " + humanize(action.targetCode)
            : "")
      );
      setText(
        detail,
        [
          action.urgency ? humanize(action.urgency) + " priority" : "",
          action.dueAt ? "Due " + readableDateTime(action.dueAt) : ""
        ].filter(Boolean).join(" · ")
      );
      item.append(title, detail);
      actionFragment.append(item);
    });
    elements["file-intelligence-actions"].replaceChildren(
      actionFragment
    );
  }

  function renderLane(name, items) {
    const container = elements[name + "-lane"];
    setText(elements[name + "-count"], String(items.length));
    if (!items.length) {
      renderRecentEmpty(container, "Nothing is currently in this lane.");
      return;
    }

    const fragment = document.createDocumentFragment();
    items.forEach(function (item) {
      const wrapper = document.createElement("div");
      const title = document.createElement("strong");
      const detail = document.createElement("span");
      wrapper.className = "lane-item";
      setText(title, LANE_LABELS[item.reasonCode] || humanize(item.reasonCode));
      setText(
        detail,
        humanize(item.source || "source") +
          (item.at ? " · " + readableDateTime(item.at) : "")
      );
      wrapper.append(title, detail);
      fragment.append(wrapper);
    });
    container.replaceChildren(fragment);
  }

  function renderRecentList(container, items, category) {
    if (!items.length) {
      renderRecentEmpty(container, "No recent " + category + " were returned.");
      return;
    }
    const fragment = document.createDocumentFragment();
    items.forEach(function (item) {
      fragment.append(createRecentItem(item));
    });
    container.replaceChildren(fragment);
  }

  function createRecentItem(item) {
    const wrapper = document.createElement("div");
    const title = document.createElement("strong");
    const detail = document.createElement("span");
    wrapper.className = "recent-item";

    let titleText = item.label || item.fileName || item.subject || item.preview;
    let details = [];
    let secondary = "";
    if (item.category === "activity") {
      titleText = titleText || humanize(item.typeCode || "activity");
      details = [item.actorRole, item.state, readableDateTime(item.occurredAt)];
    } else if (item.category === "task") {
      titleText = titleText || humanize(item.typeCode || "task");
      details = [item.priority, item.status, readableDateTime(item.dueAt)];
    } else if (item.category === "document") {
      titleText = titleText || humanize(item.typeCode || "document");
      details = [item.reviewState, readableDateTime(item.createdAt)];
    } else if (item.category === "gmail") {
      titleText = titleText || "Gmail message";
      secondary = item.snippet;
      details = [
        item.direction,
        item.actionState,
        item.hasAttachment ? "attachment" : "",
        readableDateTime(item.occurredAt)
      ];
    } else {
      titleText = titleText || humanize(item.channel || "Quo contact");
      details = [
        item.channel,
        item.direction,
        item.disposition,
        item.actionState,
        readableDateTime(item.occurredAt)
      ];
    }

    setText(title, titleText);
    setText(
      detail,
      [secondary].concat(details.map(function (value) {
        return value ? humanize(value) : "";
      })).filter(Boolean).join(" · ")
    );
    wrapper.append(title, detail);
    return wrapper;
  }

  function resetFileEvidenceContainers(message) {
    renderRecentEmpty(elements["source-health"], message);
    renderRecentEmpty(elements["key-facts"], message);
    badge(
      elements["file-intelligence-urgency"],
      "Not loaded",
      "neutral"
    );
    setText(elements["file-intelligence-summary"], message);
    renderRecentEmpty(
      elements["file-intelligence-workflows"],
      message
    );
    renderRecentEmpty(
      elements["file-intelligence-actions"],
      message
    );
    ["priority", "today", "waiting"].forEach(function (name) {
      setText(elements[name + "-count"], "0");
      renderRecentEmpty(elements[name + "-lane"], message);
    });
    [
      "recent-tasks",
      "recent-documents",
      "recent-gmail",
      "recent-quo",
      "recent-activities"
    ].forEach(function (id) {
      renderRecentEmpty(elements[id], message);
    });
  }

  function renderWorkspaceEmpty(container, message) {
    const paragraph = document.createElement("p");
    paragraph.className = "workspace-empty";
    setText(paragraph, message);
    container.replaceChildren(paragraph);
  }

  function renderRecentEmpty(container, message) {
    const paragraph = document.createElement("p");
    paragraph.className = "recent-empty";
    setText(paragraph, message);
    container.replaceChildren(paragraph);
  }

  function syncActionAccess() {
    if (!navigator.onLine || !hasBrowserAuthority()) {
      clearActionControlData(
        navigator.onLine
          ? "Action and receipt data was cleared because authority is unavailable."
          : "Action and receipt data was cleared when the connection went offline."
      );
      renderApprovalLocked(
        navigator.onLine ? "Sign in required" : "Offline",
        "Fresh authority is required before action plans can be reviewed."
      );
      renderReceiptLocked(
        navigator.onLine ? "Sign in required" : "Offline",
        "Fresh authority is required before receipt metadata can be reviewed."
      );
      return;
    }

    if (hasActionReadAuthority()) {
      elements["approval-locked"].hidden = true;
      elements["approval-workspace"].hidden = false;
      elements["approval-refresh"].hidden = false;
      badge(elements["approval-status"], "Exact review", "good");
      if (state.actionPlans === null && !state.actionLoading) {
        loadActionPlans();
      }
    } else {
      clearApprovalData("No action plans are retained without approval-read authority.");
      renderApprovalLocked(
        "Not authorized",
        "This session does not have the exact action-plan read capability."
      );
    }

    if (hasReceiptReadAuthority()) {
      elements["receipt-locked"].hidden = true;
      elements["receipt-workspace"].hidden = false;
      elements["receipt-refresh"].hidden = false;
      badge(elements["receipt-status"], "Metadata only", "good");
      if (state.receipts === null && !state.receiptLoading) {
        loadReceipts();
      }
    } else {
      clearReceiptData("No receipt metadata is retained without receipt-read authority.");
      renderReceiptLocked(
        "Not authorized",
        "This session does not have the exact receipt-read capability."
      );
    }

    renderActionComposerState();
    syncExecutionControls();
  }

  function renderApprovalLocked(status, message) {
    elements["approval-locked"].hidden = false;
    elements["approval-workspace"].hidden = true;
    elements["approval-refresh"].hidden = true;
    badge(elements["approval-status"], status, "neutral");
    notice(elements["approval-alert"], message, "neutral");
  }

  function renderReceiptLocked(status, message) {
    elements["receipt-locked"].hidden = false;
    elements["receipt-workspace"].hidden = true;
    elements["receipt-refresh"].hidden = true;
    badge(elements["receipt-status"], status, "neutral");
    notice(elements["receipt-alert"], message, "neutral");
  }

  function clearActionControlData(message) {
    clearApprovalData(message);
    clearReceiptData(message);
    resetActionComposerForFile(
      "Choose one exact fresh file before preparing actions."
    );
  }

  function clearApprovalData(message) {
    if (state.actionController) state.actionController.abort();
    state.actionController = null;
    state.actionLoading = false;
    state.actionPlans = null;
    state.selectedPlanId = null;
    state.actionPlan = null;
    elements["approval-list"].setAttribute("aria-busy", "false");
    elements["approval-refresh"].disabled = false;
    setText(elements["approval-count"], "0");
    renderWorkspaceEmpty(
      elements["approval-list"],
      message || "No action plans are retained on this page."
    );
    purgeApprovalDetailDom();
  }

  function clearReceiptData(message) {
    if (state.receiptController) state.receiptController.abort();
    state.receiptController = null;
    state.receiptLoading = false;
    state.receipts = null;
    state.selectedReceiptPlanId = null;
    state.receipt = null;
    elements["receipt-list"].setAttribute("aria-busy", "false");
    elements["receipt-refresh"].disabled = false;
    setText(elements["receipt-count"], "0");
    renderWorkspaceEmpty(
      elements["receipt-list"],
      message || "No receipt metadata is retained on this page."
    );
    purgeReceiptDetailDom();
  }

  function purgeApprovalDetailDom() {
    elements["approval-placeholder"].hidden = false;
    elements["approval-detail"].hidden = true;
    setText(elements["approval-plan-title"], "Action plan");
    badge(elements["approval-plan-state"], "Not loaded", "neutral");
    setText(elements["approval-plan-id"], "—");
    setText(elements["approval-file-ref"], "—");
    setText(elements["approval-expires-at"], "—");
    setText(elements["approval-digest"], "—");
    elements["approval-operations"].replaceChildren();
    elements["approval-acknowledge"].checked = false;
    elements["approval-acknowledge"].disabled = true;
    elements["approval-invalidate"].disabled = true;
    elements["approval-execute"].disabled = true;
    setText(
      elements["execution-gate-message"],
      "Choose one pending immutable plan before action-time approval."
    );
  }

  function purgeReceiptDetailDom() {
    elements["receipt-placeholder"].hidden = false;
    elements["receipt-detail"].hidden = true;
    setText(elements["receipt-detail-heading"], "Receipt");
    badge(elements["receipt-detail-state"], "Not loaded", "neutral");
    elements["receipt-detail-fields"].replaceChildren();
  }

  function resetActionComposerForFile(message) {
    state.actionDraft = [];
    elements["action-form"].reset();
    elements["action-type"].value = "jobnimbus.create_note";
    resetReferenceSelect(elements["update-task-ref"], "Choose a task");
    resetReferenceSelect(
      elements["update-event-ref"],
      "Choose an appointment"
    );
    resetReferenceSelect(
      elements["gmail-send-draft-ref"],
      "Choose a reviewed draft"
    );
    renderActionFields();
    renderActionComposerState();
    notice(
      elements["action-composer-alert"],
      message || "No action draft is retained.",
      "neutral"
    );
  }

  function clearActionDraft(message) {
    state.actionDraft = [];
    renderActionComposerState();
    notice(
      elements["action-composer-alert"],
      message || "The memory-only action draft was cleared.",
      "neutral"
    );
  }

  function renderActionFields() {
    const selectedType = elements["action-type"].value;
    document.querySelectorAll("[data-action-fields]").forEach(function (panel) {
      panel.hidden = panel.dataset.actionFields !== selectedType;
    });
    prefillFreshFileActionMaterial(selectedType);
  }

  function populateTaskOptions(tasks) {
    const select = elements["update-task-ref"];
    const fragment = document.createDocumentFragment();
    const emptyOption = document.createElement("option");
    emptyOption.value = "";
    setText(emptyOption, "Choose a task");
    fragment.append(emptyOption);
    tasks.forEach(function (task) {
      if (!TASK_REF.test(task.reference)) return;
      const option = document.createElement("option");
      option.value = task.reference;
      setText(
        option,
        (task.label || humanize(task.typeCode || "Task"))
          + (task.status ? " · " + humanize(task.status) : "")
      );
      fragment.append(option);
    });
    select.replaceChildren(fragment);
  }

  function populateEventOptions(activities) {
    replaceReferenceOptions(
      elements["update-event-ref"],
      "Choose an appointment",
      activities.filter(function (activity) {
        return (
          EVIDENCE_REF.test(activity.reference)
          && ["event", "appointment"].includes(activity.typeCode)
        );
      }).map(function (activity) {
        return {
          reference: activity.reference,
          label:
            (activity.label || humanize(activity.typeCode))
            + (
              activity.occurredAt
                ? " · " + readableDateTime(activity.occurredAt)
                : ""
            )
        };
      })
    );
  }

  function populateDraftOptions() {
    const rows = [];
    const seen = new Set();
    const plans = []
      .concat(Array.isArray(state.actionPlans) ? state.actionPlans : [])
      .concat(state.actionPlan ? [state.actionPlan] : []);
    plans.forEach(function (plan) {
      if (plan.fileRef !== state.selectedFileRef) return;
      (plan.createdDraftRefs || []).forEach(function (reference) {
        if (!EVIDENCE_REF.test(reference) || seen.has(reference)) return;
        seen.add(reference);
        rows.push({
          reference: reference,
          label: "Reviewed draft from " + plan.planId.slice(0, 13) + "…"
        });
      });
    });
    replaceReferenceOptions(
      elements["gmail-send-draft-ref"],
      "Choose a reviewed draft",
      rows
    );
  }

  function resetReferenceSelect(select, emptyLabel) {
    const emptyOption = document.createElement("option");
    emptyOption.value = "";
    setText(emptyOption, emptyLabel);
    select.replaceChildren(emptyOption);
  }

  function replaceReferenceOptions(select, emptyLabel, rows) {
    const current = select.value;
    const fragment = document.createDocumentFragment();
    const emptyOption = document.createElement("option");
    emptyOption.value = "";
    setText(emptyOption, emptyLabel);
    fragment.append(emptyOption);
    rows.forEach(function (row) {
      if (!EVIDENCE_REF.test(row.reference)) return;
      const option = document.createElement("option");
      option.value = row.reference;
      setText(option, row.label);
      fragment.append(option);
    });
    select.replaceChildren(fragment);
    if (rows.some(function (row) {
      return row.reference === current;
    })) {
      select.value = current;
    }
  }

  function prefillFreshFileActionMaterial(type) {
    const file = record(state.fileReview).file;
    if (!file || typeof file !== "object") return;
    if (type === "gmail.create_draft" && !elements["gmail-draft-to"].value) {
      const email = boundedString(record(file.client).primaryEmail, 254);
      if (email) elements["gmail-draft-to"].value = email;
    }
    if (type === "quo.send_text" && !elements["quo-text-to"].value) {
      const phone = e164Phone(record(file.client).primaryPhone, false);
      if (phone) elements["quo-text-to"].value = phone;
    }
  }

  function renderActionComposerState() {
    populateDraftOptions();
    const available = Boolean(
      navigator.onLine
      && hasActionPrepareAuthority()
      && state.fileReview
      && state.selectedFileRef
      && state.fileReview.file.fileRef === state.selectedFileRef
      && !state.fileLoading
    );
    const controls = elements["action-form"].querySelectorAll(
      "input, select, textarea, button"
    );
    controls.forEach(function (control) {
      control.disabled = !available || state.actionLoading;
    });
    if (
      available
      && elements["update-task-ref"].options.length <= 1
    ) {
      elements["update-task-ref"].disabled = true;
    }
    if (
      available
      && elements["update-event-ref"].options.length <= 1
    ) {
      elements["update-event-ref"].disabled = true;
    }
    if (
      available
      && elements["gmail-send-draft-ref"].options.length <= 1
    ) {
      elements["gmail-send-draft-ref"].disabled = true;
    }
    elements["action-draft-clear"].disabled =
      state.actionDraft.length === 0 || state.actionLoading;
    elements["action-prepare"].disabled =
      !available
      || state.actionLoading
      || state.actionDraft.length === 0;
    setText(
      elements["action-composer-count"],
      state.actionDraft.length + " / " + MAX_ACTIONS + " actions"
    );
    renderActionDraft();
    if (!available) {
      notice(
        elements["action-composer-alert"],
        state.fileReview
          ? "This session cannot prepare actions for the selected file."
          : "Open one exact fresh file before preparing actions.",
        "neutral"
      );
    } else if (state.actionDraft.length > 0) {
      notice(
        elements["action-composer-alert"],
        "The draft is memory only. Prepare it to create an immutable server review.",
        "good"
      );
    }
  }

  function addDraftAction(event) {
    event.preventDefault();
    if (
      !hasActionPrepareAuthority()
      || !state.fileReview
      || state.fileReview.file.fileRef !== state.selectedFileRef
    ) {
      notice(
        elements["action-composer-alert"],
        "Fresh exact-file authority is required before adding an action.",
        "bad"
      );
      return;
    }
    if (state.actionDraft.length >= MAX_ACTIONS) {
      notice(
        elements["action-composer-alert"],
        "A review batch may contain no more than 12 exact actions.",
        "warn"
      );
      return;
    }

    try {
      const operation = buildDraftOperation();
      state.actionDraft = state.actionDraft.concat([operation]);
      clearActionEntryFields(operation.type);
      renderActionComposerState();
    } catch (error) {
      notice(
        elements["action-composer-alert"],
        stringValue(error.message) || "Enter all required exact action material.",
        "warn"
      );
    }
  }

  function buildDraftOperation() {
    const type = elements["action-type"].value;
    if (!Object.hasOwn(ACTION_LABELS, type)) {
      throw new Error("That action is not enabled for HCN v1.");
    }

    if (type === "jobnimbus.create_note") {
      const note = exactMultilineText(elements["action-note"].value, 8192, "Enter the exact note.");
      return { type: type, input: { note: note } };
    }

    if (type === "jobnimbus.create_task") {
      const title = exactTitle(
        elements["create-task-title"].value,
        "Enter a task title without leading or trailing spaces."
      );
      const input = { title: title };
      const description = elements["create-task-description"].value;
      const dueDate = elements["create-task-due-date"].value;
      if (description) {
        input.description = exactMultilineText(
          description,
          4096,
          "The task description is not valid bounded text."
        );
      }
      if (dueDate) input.dueDate = exactIsoDate(dueDate);
      return { type: type, input: input };
    }

    if (type === "jobnimbus.update_task") {
      const taskRef = elements["update-task-ref"].value;
      if (!TASK_REF.test(taskRef)) {
        throw new Error("Choose a task from this fresh file.");
      }
      const input = { taskRef: taskRef };
      let changes = 0;
      const title = elements["update-task-title"].value;
      const description = elements["update-task-description"].value;
      const dueDate = elements["update-task-due-date"].value;
      const completed = elements["update-task-completed"].value;
      if (title) {
        input.title = exactTitle(
          title,
          "The new task title cannot have leading or trailing spaces."
        );
        changes += 1;
      }
      if (description) {
        input.description = exactMultilineText(
          description,
          4096,
          "The new task description is not valid bounded text."
        );
        changes += 1;
      }
      if (dueDate) {
        input.dueDate = exactIsoDate(dueDate);
        changes += 1;
      }
      if (completed === "true" || completed === "false") {
        input.completed = completed === "true";
        changes += 1;
      }
      if (changes === 0) {
        throw new Error("Enter at least one exact task change.");
      }
      return { type: type, input: input };
    }

    if (type === "jobnimbus.update_status") {
      const status = exactSingleLineText(
        elements["action-status"].value,
        128,
        "Enter the requested JobNimbus status."
      );
      return { type: type, input: { status: status } };
    }

    if (type === "jobnimbus.update_contact") {
      const dateOfLoss = exactIsoDate(elements["action-date-of-loss"].value);
      return { type: type, input: { dateOfLoss: dateOfLoss } };
    }

    if (type === "jobnimbus.create_calendar_event") {
      const startsAt = centralLocalDateTimeToIso(
        elements["create-event-start"].value
      );
      const endsAt = centralLocalDateTimeToIso(
        elements["create-event-end"].value
      );
      assertDateRange(startsAt, endsAt);
      const input = {
        title: exactTitle(
          elements["create-event-title"].value,
          "Enter an appointment title without leading or trailing spaces."
        ),
        startsAt: startsAt,
        endsAt: endsAt
      };
      const description = elements["create-event-description"].value;
      if (description) {
        input.description = exactMultilineText(
          description,
          4096,
          "The appointment details are not valid bounded text."
        );
      }
      return { type: type, input: input };
    }

    if (type === "jobnimbus.update_calendar_event") {
      const eventRef = elements["update-event-ref"].value;
      if (!EVIDENCE_REF.test(eventRef)) {
        throw new Error("Choose an appointment from this fresh file.");
      }
      const input = { eventRef: eventRef };
      let changes = 0;
      const title = elements["update-event-title"].value;
      const description = elements["update-event-description"].value;
      const start = elements["update-event-start"].value;
      const end = elements["update-event-end"].value;
      if (title) {
        input.title = exactTitle(
          title,
          "The new appointment title cannot have leading or trailing spaces."
        );
        changes += 1;
      }
      if (description) {
        input.description = exactMultilineText(
          description,
          4096,
          "The new appointment details are not valid bounded text."
        );
        changes += 1;
      }
      if (Boolean(start) !== Boolean(end)) {
        throw new Error("Set both the new start and end time.");
      }
      if (start && end) {
        input.startsAt = centralLocalDateTimeToIso(start);
        input.endsAt = centralLocalDateTimeToIso(end);
        assertDateRange(input.startsAt, input.endsAt);
        changes += 2;
      }
      if (changes === 0) {
        throw new Error("Enter at least one exact appointment change.");
      }
      return { type: type, input: input };
    }

    if (type === "gmail.create_draft") {
      const input = {
        to: exactSingleLineText(
          elements["gmail-draft-to"].value,
          2000,
          "Enter the exact email recipient."
        ),
        subject: exactSingleLineText(
          elements["gmail-draft-subject"].value,
          998,
          "Enter the exact email subject."
        ),
        body: exactMultilineText(
          elements["gmail-draft-body"].value,
          48 * 1024,
          "Enter the exact email body."
        )
      };
      const cc = elements["gmail-draft-cc"].value;
      const bcc = elements["gmail-draft-bcc"].value;
      if (cc) {
        input.cc = exactSingleLineText(
          cc,
          2000,
          "Enter exact single-line CC recipients."
        );
      }
      if (bcc) {
        input.bcc = exactSingleLineText(
          bcc,
          2000,
          "Enter exact single-line BCC recipients."
        );
      }
      return { type: type, input: input };
    }

    if (type === "gmail.send") {
      const draftRef = elements["gmail-send-draft-ref"].value;
      if (!EVIDENCE_REF.test(draftRef)) {
        throw new Error(
          "Choose a reviewed draft that was created for this file."
        );
      }
      return { type: type, input: { draftRef: draftRef } };
    }

    if (type === "quo.send_text") {
      return {
        type: type,
        input: {
          to: e164Phone(elements["quo-text-to"].value, true),
          content: exactTrimmedMultilineText(
            elements["quo-text-content"].value,
            1600,
            "Enter the exact text without leading or trailing spaces."
          )
        }
      };
    }

    throw new Error("That action is not enabled for HCN v1.");
  }

  function exactTitle(value, message) {
    if (
      typeof value !== "string"
      || !value
      || value !== value.trim()
      || Array.from(value).length > 256
      || /[\r\n\u2028\u2029\u0000-\u001f\u007f]/.test(value)
    ) {
      throw new Error(message);
    }
    return value;
  }

  function exactSingleLineText(value, maximum, message) {
    const text = typeof value === "string" ? value.trim() : "";
    if (
      !text
      || Array.from(text).length > maximum
      || /[\r\n\u2028\u2029\u0000-\u001f\u007f]/.test(text)
    ) {
      throw new Error(message);
    }
    return text;
  }

  function exactMultilineText(value, maximumBytes, message) {
    if (
      typeof value !== "string"
      || value.trim().length === 0
      || new TextEncoder().encode(value).length > maximumBytes
      || /[\u0000\u0008\u000b\u000c\u007f]/.test(value)
    ) {
      throw new Error(message);
    }
    return value;
  }

  function exactTrimmedMultilineText(value, maximumCharacters, message) {
    if (
      typeof value !== "string"
      || !value
      || value !== value.trim()
      || Array.from(value).length > maximumCharacters
      || /[\u0000\u0008\u000b\u000c\u007f]/.test(value)
    ) {
      throw new Error(message);
    }
    return value;
  }

  function e164Phone(value, required) {
    const text = typeof value === "string" ? value.trim() : "";
    if (E164_PHONE.test(text)) return text;
    const digits = text.replace(/\D/g, "");
    const normalized =
      digits.length === 10
        ? "+1" + digits
        : digits.length === 11 && digits.startsWith("1")
          ? "+" + digits
          : "";
    if (E164_PHONE.test(normalized)) return normalized;
    if (required) {
      throw new Error("Enter one verified phone number, including area code.");
    }
    return "";
  }

  function centralLocalDateTimeToIso(value) {
    const match = String(value || "").match(
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/
    );
    if (!match) {
      throw new Error("Choose a complete appointment date and time.");
    }
    const target = match.slice(1).map(function (part, index) {
      return index === 5 && part === undefined ? 0 : Number(part);
    });
    const targetAsUtc = Date.UTC(
      target[0],
      target[1] - 1,
      target[2],
      target[3],
      target[4],
      target[5],
      0
    );
    const check = new Date(targetAsUtc);
    if (
      check.getUTCFullYear() !== target[0]
      || check.getUTCMonth() + 1 !== target[1]
      || check.getUTCDate() !== target[2]
      || check.getUTCHours() !== target[3]
      || check.getUTCMinutes() !== target[4]
      || check.getUTCSeconds() !== target[5]
    ) {
      throw new Error("Choose a real appointment date and time.");
    }

    let candidate = targetAsUtc;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const displayed = centralDateTimeParts(candidate);
      const displayedAsUtc = Date.UTC(
        displayed[0],
        displayed[1] - 1,
        displayed[2],
        displayed[3],
        displayed[4],
        displayed[5],
        0
      );
      candidate += targetAsUtc - displayedAsUtc;
    }
    if (!sameDateTimeParts(centralDateTimeParts(candidate), target)) {
      throw new Error(
        "That Central time does not exist because the clock changes then."
      );
    }
    const ambiguous = [-3_600_000, 3_600_000].some(function (offset) {
      return sameDateTimeParts(
        centralDateTimeParts(candidate + offset),
        target
      );
    });
    if (ambiguous) {
      throw new Error(
        "That Central time occurs twice because the clock changes then. Choose a different time."
      );
    }
    const result = new Date(candidate).toISOString();
    if (!ISO_INSTANT.test(result)) {
      throw new Error("The appointment time could not be verified.");
    }
    return result;
  }

  function centralDateTimeParts(milliseconds) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date(milliseconds));
    const values = Object.fromEntries(parts.map(function (part) {
      return [part.type, part.value];
    }));
    return [
      Number(values.year),
      Number(values.month),
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
      Number(values.second)
    ];
  }

  function sameDateTimeParts(left, right) {
    return left.every(function (value, index) {
      return value === right[index];
    });
  }

  function assertDateRange(startsAt, endsAt) {
    if (Date.parse(endsAt) < Date.parse(startsAt)) {
      throw new Error("The appointment end must be after its start.");
    }
  }

  function exactIsoDate(value) {
    if (!ISO_DATE.test(String(value || ""))) {
      throw new Error("Choose a real date in YYYY-MM-DD format.");
    }
    const date = new Date(value + "T00:00:00.000Z");
    if (
      Number.isNaN(date.getTime())
      || date.toISOString().slice(0, 10) !== value
    ) {
      throw new Error("Choose a real date in YYYY-MM-DD format.");
    }
    return value;
  }

  function clearActionEntryFields(type) {
    const ids = {
      "jobnimbus.create_note": ["action-note"],
      "jobnimbus.create_task": [
        "create-task-title",
        "create-task-description",
        "create-task-due-date"
      ],
      "jobnimbus.update_task": [
        "update-task-ref",
        "update-task-title",
        "update-task-description",
        "update-task-due-date",
        "update-task-completed"
      ],
      "jobnimbus.update_status": ["action-status"],
      "jobnimbus.update_contact": ["action-date-of-loss"],
      "jobnimbus.create_calendar_event": [
        "create-event-title",
        "create-event-description",
        "create-event-start",
        "create-event-end"
      ],
      "jobnimbus.update_calendar_event": [
        "update-event-ref",
        "update-event-title",
        "update-event-description",
        "update-event-start",
        "update-event-end"
      ],
      "gmail.create_draft": [
        "gmail-draft-to",
        "gmail-draft-cc",
        "gmail-draft-bcc",
        "gmail-draft-subject",
        "gmail-draft-body"
      ],
      "gmail.send": ["gmail-send-draft-ref"],
      "quo.send_text": ["quo-text-to", "quo-text-content"]
    };
    (ids[type] || []).forEach(function (id) {
      elements[id].value = "";
    });
    prefillFreshFileActionMaterial(type);
  }

  function renderActionDraft() {
    if (!state.actionDraft.length) {
      renderRecentEmpty(
        elements["action-draft-list"],
        "No actions have been added."
      );
      return;
    }
    const fragment = document.createDocumentFragment();
    state.actionDraft.forEach(function (operation, index) {
      const card = document.createElement("article");
      const heading = document.createElement("div");
      const title = document.createElement("strong");
      const number = document.createElement("span");
      const remove = document.createElement("button");
      card.className = "draft-action";
      heading.className = "draft-action-heading";
      setText(title, ACTION_LABELS[operation.type]);
      setText(number, "Action " + (index + 1));
      heading.append(title, number);
      card.append(heading);
      card.append(createMaterialList(operation.type, operation.input));
      remove.type = "button";
      remove.className = "text-button draft-remove";
      remove.disabled = state.actionLoading;
      setText(remove, "Remove action");
      remove.addEventListener("click", function () {
        state.actionDraft = state.actionDraft.filter(function (_item, itemIndex) {
          return itemIndex !== index;
        });
        renderActionComposerState();
      });
      card.append(remove);
      fragment.append(card);
    });
    elements["action-draft-list"].replaceChildren(fragment);
  }

  function createMaterialList(type, material) {
    const list = document.createElement("dl");
    list.className = "material-list";
    materialRows(type, material).forEach(function (row) {
      const wrapper = document.createElement("div");
      const term = document.createElement("dt");
      const detail = document.createElement("dd");
      setText(term, row[0]);
      setText(detail, row[1]);
      wrapper.append(term, detail);
      list.append(wrapper);
    });
    return list;
  }

  function materialRows(type, material) {
    const source = record(material);
    if (type === "jobnimbus.create_note") {
      return [["Exact note", source.note]];
    }
    if (type === "jobnimbus.create_task") {
      return [
        ["Title", source.title],
        ["Description", source.description],
        ["Due date", source.dueDate]
      ].filter(function (row) {
        return row[1] !== undefined && row[1] !== "";
      });
    }
    if (type === "jobnimbus.update_task") {
      return [
        ["Task reference", source.taskRef],
        ["New title", source.title],
        ["New description", source.description],
        ["New due date", source.dueDate],
        [
          "Completion",
          source.completed === true
            ? "Mark complete"
            : source.completed === false
              ? "Mark open"
              : undefined
        ]
      ].filter(function (row) {
        return row[1] !== undefined && row[1] !== "";
      });
    }
    if (type === "jobnimbus.update_status") {
      return [
        ["Requested status", source.requestedStatus || source.status],
        ["Resolved status", source.resolvedStatus]
      ].filter(function (row) {
        return row[1] !== undefined && row[1] !== "";
      });
    }
    if (type === "jobnimbus.update_contact") {
      return [["Date of loss", source.dateOfLoss]];
    }
    if (
      type === "jobnimbus.create_calendar_event"
      || type === "jobnimbus.update_calendar_event"
    ) {
      return [
        ["Appointment reference", source.eventRef],
        [type === "jobnimbus.update_calendar_event" ? "New title" : "Title", source.title],
        [
          type === "jobnimbus.update_calendar_event" ? "New details" : "Details",
          source.description
        ],
        [
          type === "jobnimbus.update_calendar_event" ? "New start" : "Starts",
          readableCentralDateTime(source.startsAt)
        ],
        [
          type === "jobnimbus.update_calendar_event" ? "New end" : "Ends",
          readableCentralDateTime(source.endsAt)
        ],
        [
          "Time zone",
          source.timeZone
          || (source.startsAt || source.endsAt ? "America/Chicago" : undefined)
        ]
      ].filter(function (row) {
        return row[1] !== undefined && row[1] !== "";
      });
    }
    if (type === "gmail.create_draft" || type === "gmail.send") {
      const rows = [
        ["Reviewed draft reference", source.draftRef],
        ["To", source.to],
        ["CC", source.cc],
        ["BCC", source.bcc],
        ["Subject", source.subject],
        ["Exact email", source.body]
      ].filter(function (row) {
        return row[1] !== undefined && row[1] !== "";
      });
      const attachments = Array.isArray(source.attachments)
        ? source.attachments
        : [];
      if (!attachments.length) {
        rows.push(["Attachments", "None"]);
      } else {
        attachments.forEach(function (attachment, index) {
          rows.push([
            "Attachment " + (index + 1),
            [
              attachment.filename,
              attachment.mimeType,
              Number.isInteger(attachment.bytes)
                ? attachment.bytes + " bytes"
                : "",
              attachment.sha256 ? "SHA-256 " + attachment.sha256 : "",
              attachment.disposition
            ].filter(Boolean).join(" · ")
          ]);
        });
      }
      if (source.contentDigest) {
        rows.push(["Content digest", source.contentDigest]);
      }
      if (source.sourceDraftRetention) {
        rows.push([
          "Source draft",
          humanize(source.sourceDraftRetention)
        ]);
      }
      return rows;
    }
    if (type === "quo.send_text") {
      return [
        ["From", source.from],
        ["To", source.to],
        ["Exact text", source.content],
        ["Character count", source.characterCount]
      ].filter(function (row) {
        return row[1] !== undefined && row[1] !== "";
      });
    }
    return [];
  }

  async function prepareActionPlan() {
    if (
      state.actionLoading
      || !hasActionPrepareAuthority()
      || !state.selectedFileRef
      || !state.fileReview
      || state.actionDraft.length === 0
    ) {
      return;
    }
    const fileRef = state.selectedFileRef;
    const operations = state.actionDraft.map(function (operation) {
      return {
        type: operation.type,
        input: { ...operation.input }
      };
    });
    const controller = new AbortController();
    if (state.actionController) state.actionController.abort();
    state.actionController = controller;
    state.actionLoading = true;
    renderActionComposerState();
    badge(elements["approval-status"], "Preparing", "neutral");
    notice(
      elements["approval-alert"],
      "Preparing a server-validated immutable dry run. No effects are running.",
      "neutral"
    );
    let preparedPlanId = "";

    try {
      const response = await postOperationalJson(
        ENDPOINTS.actionPrepare,
        { fileRef: fileRef, operations: operations },
        controller.signal,
        ACTION_PREPARE_CAPABILITY
      );
      if (controller.signal.aborted) return;
      const plan = normalizePlanResponse(response, true);
      preparedPlanId = plan.planId;
      state.actionPlan = plan;
      state.selectedPlanId = plan.planId;
      state.actionPlans = upsertPlanSummary(state.actionPlans || [], plan);
      state.actionDraft = [];
      renderActionPlanList();
      renderActionPlanDetail(plan);
      notice(
        elements["approval-alert"],
        "Immutable review prepared. Nothing has been executed.",
        "good"
      );
      document.getElementById("approvals").scrollIntoView({ block: "start" });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (isAuthorizationStatus(error)) {
        handleOperationalAuthLoss();
        return;
      }
      notice(
        elements["approval-alert"],
        actionPlanErrorMessage(error, "prepare"),
        "bad"
      );
      notice(
        elements["action-composer-alert"],
        "The draft remains in memory because preparation did not complete.",
        "warn"
      );
    } finally {
      if (state.actionController === controller) {
        state.actionController = null;
        state.actionLoading = false;
        renderActionPlanList();
        renderActionComposerState();
        syncExecutionControls();
      }
    }
    if (preparedPlanId && hasActionReadAuthority()) {
      await loadActionPlans({ selectPlanId: preparedPlanId });
    }
  }

  async function loadActionPlans(options) {
    if (state.actionLoading || !hasActionReadAuthority() || !navigator.onLine) {
      return;
    }
    const requestedPlanId = PLAN_ID.test(String(options?.selectPlanId || ""))
      ? options.selectPlanId
      : state.selectedPlanId;
    if (state.actionController) state.actionController.abort();
    const controller = new AbortController();
    state.actionController = controller;
    state.actionLoading = true;
    elements["approval-list"].setAttribute("aria-busy", "true");
    elements["approval-refresh"].disabled = true;
    badge(elements["approval-status"], "Loading", "neutral");
    notice(elements["approval-alert"], "Loading current session action plans.", "neutral");
    let detailPlanId = "";

    try {
      const response = await postOperationalJson(
        ENDPOINTS.actionList,
        {},
        controller.signal,
        ACTION_READ_CAPABILITY
      );
      if (controller.signal.aborted) return;
      state.actionPlans = normalizePlanListResponse(response);
      const selected = state.actionPlans.find(function (plan) {
        return plan.planId === requestedPlanId;
      }) || state.actionPlans.find(function (plan) {
        return plan.status === "pending";
      }) || state.actionPlans[0];
      state.selectedPlanId = selected ? selected.planId : null;
      state.actionPlan = null;
      renderActionPlanList();
      if (selected) {
        detailPlanId = selected.planId;
      } else {
        purgeApprovalDetailDom();
      }
      badge(
        elements["approval-status"],
        state.actionPlans.length + " plan" + (state.actionPlans.length === 1 ? "" : "s"),
        "good"
      );
      notice(
        elements["approval-alert"],
        state.actionPlans.length
          ? "Choose a plan to inspect its exact immutable material."
          : "There are no action plans for this browser session.",
        "good"
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      if (isAuthorizationStatus(error)) {
        handleOperationalAuthLoss();
        return;
      }
      state.actionPlans = null;
      state.selectedPlanId = null;
      state.actionPlan = null;
      renderWorkspaceEmpty(
        elements["approval-list"],
        "Action plans could not be loaded. No stale list is shown."
      );
      purgeApprovalDetailDom();
      badge(elements["approval-status"], "Unavailable", "bad");
      notice(
        elements["approval-alert"],
        actionPlanErrorMessage(error, "list"),
        "bad"
      );
    } finally {
      if (state.actionController === controller) {
        state.actionController = null;
        state.actionLoading = false;
        elements["approval-list"].setAttribute("aria-busy", "false");
        elements["approval-refresh"].disabled = false;
        renderActionPlanList();
        renderActionComposerState();
      }
    }
    if (detailPlanId && hasActionReadAuthority()) {
      await loadActionPlanDetail(detailPlanId);
    }
  }

  async function loadActionPlanDetail(planId) {
    if (
      state.actionLoading
      || !hasActionReadAuthority()
      || !PLAN_ID.test(String(planId || ""))
    ) {
      return;
    }
    if (state.actionController) state.actionController.abort();
    const controller = new AbortController();
    state.actionController = controller;
    state.actionLoading = true;
    state.selectedPlanId = planId;
    state.actionPlan = null;
    elements["approval-acknowledge"].checked = false;
    renderActionPlanList();
    purgeApprovalDetailDom();
    notice(elements["approval-alert"], "Loading exact immutable plan detail.", "neutral");

    try {
      const response = await postOperationalJson(
        ENDPOINTS.actionDetail,
        { planId: planId },
        controller.signal,
        ACTION_READ_CAPABILITY
      );
      if (controller.signal.aborted) return;
      const plan = normalizePlanResponse(response, true);
      if (plan.planId !== planId) throw new Error("Plan detail did not match");
      state.actionPlan = plan;
      state.actionPlans = upsertPlanSummary(state.actionPlans || [], plan);
      renderActionPlanList();
      renderActionPlanDetail(plan);
      notice(
        elements["approval-alert"],
        "Exact server-prepared plan loaded. Review every field before approval.",
        "good"
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      if (isAuthorizationStatus(error)) {
        handleOperationalAuthLoss();
        return;
      }
      state.actionPlan = null;
      purgeApprovalDetailDom();
      notice(
        elements["approval-alert"],
        actionPlanErrorMessage(error, "detail"),
        "bad"
      );
    } finally {
      if (state.actionController === controller) {
        state.actionController = null;
        state.actionLoading = false;
        renderActionPlanList();
        syncExecutionControls();
        renderActionComposerState();
      }
    }
  }

  function normalizePlanListResponse(value) {
    assertNoStoreEnvelope(value);
    if (!Array.isArray(value.plans)) {
      throw new Error("Invalid action plan list");
    }
    return value.plans.slice(0, 50).map(function (plan) {
      return normalizeActionPlan(plan, false);
    });
  }

  function normalizePlanResponse(value, requireOperations) {
    assertNoStoreEnvelope(value);
    const plan = record(value.plan);
    if (!Object.keys(plan).length) {
      throw new Error("Invalid action plan response");
    }
    return normalizeActionPlan(plan, requireOperations);
  }

  function normalizeActionPlan(value, requireOperations) {
    const plan = record(value);
    const planId = boundedString(plan.planId, 80);
    const fileRef = boundedString(plan.fileRef, 80);
    const approvalDigest = boundedString(plan.approvalDigest, 80);
    const approvalExpiresAt = boundedString(plan.approvalExpiresAt, 40);
    const status = boundedString(plan.status, 64);
    const file = record(plan.file);
    let fileDisplayLabel = "";
    if (Object.keys(file).length) {
      if (
        boundedString(file.reference, 80) !== fileRef
        || !boundedString(file.displayLabel, 256)
      ) {
        throw new Error("Invalid action plan file");
      }
      fileDisplayLabel = boundedString(file.displayLabel, 256);
    }
    if (
      !PLAN_ID.test(planId)
      || !FILE_REF.test(fileRef)
      || !APPROVAL_DIGEST.test(approvalDigest)
      || !validIsoInstant(approvalExpiresAt)
      || !PLAN_STATUSES.has(status)
      || !Number.isInteger(plan.operationCount)
      || plan.operationCount < 1
      || plan.operationCount > MAX_ACTIONS
      || !validIsoInstant(plan.createdAt)
      || !validIsoInstant(plan.updatedAt)
    ) {
      throw new Error("Invalid action plan");
    }
    let operations = null;
    if (Array.isArray(plan.operations)) {
      if (plan.operations.length !== plan.operationCount) {
        throw new Error("Invalid action plan operations");
      }
      operations = plan.operations.map(normalizePlanOperation);
    } else if (requireOperations) {
      throw new Error("Exact action plan material is unavailable");
    }
    const createdDraftRefs = normalizeCreatedDraftRefs(
      plan.result,
      plan.operationCount
    );
    return {
      planId: planId,
      fileRef: fileRef,
      fileDisplayLabel: fileDisplayLabel,
      approvalDigest: approvalDigest,
      approvalExpiresAt: approvalExpiresAt,
      status: status,
      operationCount: plan.operationCount,
      operations: operations,
      createdDraftRefs: createdDraftRefs,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt
    };
  }

  function normalizePlanOperation(value, arrayIndex) {
    const operation = record(value);
    const type = boundedString(operation.type, 128);
    const action = boundedString(operation.action, 160);
    const index = operation.index;
    if (
      !Object.hasOwn(ACTION_LABELS, type)
      || !action
      || !Number.isInteger(index)
      || index !== arrayIndex
    ) {
      throw new Error("Invalid action plan operation");
    }
    const source = record(operation.material);
    const material = {};
    const allowed = {
      "jobnimbus.create_note": ["note"],
      "jobnimbus.create_task": ["title", "description", "dueDate"],
      "jobnimbus.update_task": [
        "taskRef",
        "title",
        "description",
        "dueDate",
        "completed"
      ],
      "jobnimbus.update_status": ["requestedStatus", "resolvedStatus"],
      "jobnimbus.update_contact": ["dateOfLoss"],
      "jobnimbus.create_calendar_event": [
        "title",
        "description",
        "startsAt",
        "endsAt",
        "timeZone"
      ],
      "jobnimbus.update_calendar_event": [
        "eventRef",
        "title",
        "description",
        "startsAt",
        "endsAt",
        "timeZone"
      ],
      "gmail.create_draft": [
        "to",
        "cc",
        "bcc",
        "subject",
        "body",
        "attachments"
      ],
      "gmail.send": [
        "draftRef",
        "to",
        "cc",
        "bcc",
        "subject",
        "body",
        "attachments",
        "contentDigest",
        "sourceDraftRetention"
      ],
      "quo.send_text": [
        "from",
        "to",
        "content",
        "characterCount"
      ]
    }[type];
    if (Object.keys(source).some(function (key) {
      return !allowed.includes(key);
    })) {
      throw new Error("Invalid action material");
    }
    allowed.forEach(function (key) {
      if (!Object.hasOwn(source, key)) return;
      if (key === "completed") {
        if (typeof source[key] !== "boolean") {
          throw new Error("Invalid action material");
        }
        material[key] = source[key];
        return;
      }
      if (key === "attachments") {
        material.attachments = normalizeAttachmentDescriptors(source[key]);
        return;
      }
      if (key === "characterCount") {
        if (
          !Number.isInteger(source[key])
          || source[key] < 1
          || source[key] > 1600
        ) {
          throw new Error("Invalid action material");
        }
        material[key] = source[key];
        return;
      }
      const maximum = key === "body" ? 48 * 1024 : 8192;
      if (typeof source[key] !== "string" || source[key].length > maximum) {
        throw new Error("Invalid action material");
      }
      material[key] = source[key];
    });
    if (
      (type === "jobnimbus.create_note" && !material.note)
      || (type === "jobnimbus.create_task" && !material.title)
      || (type === "jobnimbus.update_task" && !TASK_REF.test(material.taskRef || ""))
      || (
        type === "jobnimbus.update_status"
        && (!material.requestedStatus || !material.resolvedStatus)
      )
      || (
        type === "jobnimbus.update_contact"
        && !ISO_DATE.test(material.dateOfLoss || "")
      )
      || (
        type === "jobnimbus.create_calendar_event"
        && (
          !material.title
          || !validIsoInstant(material.startsAt)
          || !validIsoInstant(material.endsAt)
          || material.timeZone !== "America/Chicago"
        )
      )
      || (
        type === "jobnimbus.update_calendar_event"
        && (
          !EVIDENCE_REF.test(material.eventRef || "")
          || (
            !material.title
            && !material.description
            && !material.startsAt
            && !material.endsAt
          )
          || Boolean(material.startsAt) !== Boolean(material.endsAt)
          || (
            material.startsAt
            && (
              !validIsoInstant(material.startsAt)
              || !validIsoInstant(material.endsAt)
              || material.timeZone !== "America/Chicago"
            )
          )
        )
      )
      || (
        type === "gmail.create_draft"
        && (
          !material.to
          || !material.subject
          || !material.body
          || !Array.isArray(material.attachments)
          || material.attachments.length !== 0
        )
      )
      || (
        type === "gmail.send"
        && (
          !EVIDENCE_REF.test(material.draftRef || "")
          || !material.to
          || !material.subject
          || !material.body
          || !Array.isArray(material.attachments)
          || !APPROVAL_DIGEST.test(material.contentDigest || "")
          || material.sourceDraftRetention
            !== "retained_for_separate_cleanup"
        )
      )
      || (
        type === "quo.send_text"
        && (
          !E164_PHONE.test(material.from || "")
          || !E164_PHONE.test(material.to || "")
          || !material.content
          || material.characterCount !== material.content.length
        )
      )
    ) {
      throw new Error("Incomplete action material");
    }
    return {
      index: index,
      type: type,
      action: action,
      material: material
    };
  }

  function normalizeAttachmentDescriptors(value) {
    if (!Array.isArray(value) || value.length > 25) {
      throw new Error("Invalid attachment material");
    }
    let totalBytes = 0;
    return value.map(function (candidate) {
      const attachment = record(candidate);
      const allowed = [
        "partId",
        "filename",
        "mimeType",
        "bytes",
        "sha256",
        "disposition"
      ];
      const partId = boundedString(attachment.partId, 1024);
      const filename = boundedString(attachment.filename, 512);
      const mimeType = boundedString(attachment.mimeType, 256);
      const sha256 = boundedString(attachment.sha256, 80);
      if (
        Object.keys(attachment).some(function (key) {
          return !allowed.includes(key);
        })
        || !partId
        || partId !== attachment.partId
        || !filename
        || filename !== attachment.filename
        || mimeType !== attachment.mimeType
        || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(
          mimeType
        )
        || !Number.isInteger(attachment.bytes)
        || attachment.bytes < 1
        || attachment.bytes > 20 * 1024 * 1024
        || sha256 !== attachment.sha256
        || !APPROVAL_DIGEST.test(sha256)
      ) {
        throw new Error("Invalid attachment material");
      }
      totalBytes += attachment.bytes;
      if (totalBytes > 20 * 1024 * 1024) {
        throw new Error("Invalid attachment material");
      }
      const normalized = {
        partId: partId,
        filename: filename,
        mimeType: mimeType,
        bytes: attachment.bytes,
        sha256: sha256
      };
      if (Object.hasOwn(attachment, "disposition")) {
        const disposition = boundedString(
          attachment.disposition,
          128
        );
        if (disposition !== attachment.disposition) {
          throw new Error("Invalid attachment material");
        }
        normalized.disposition = disposition;
      }
      return normalized;
    });
  }

  function normalizeCreatedDraftRefs(value, operationCount) {
    if (value === undefined) return [];
    const result = record(value);
    const allowedResult = ["mode", "reason", "error", "batch"];
    if (
      !Object.keys(result).length
      || Object.keys(result).some(function (key) {
        return !allowedResult.includes(key);
      })
      || !boundedString(result.mode, 64)
    ) {
      throw new Error("Invalid action result");
    }
    if (!Object.hasOwn(result, "batch")) return [];
    const batch = record(result.batch);
    const allowedBatch = ["status", "operationCount", "completed"];
    if (
      Object.keys(batch).some(function (key) {
        return !allowedBatch.includes(key);
      })
      || !boundedString(batch.status, 64)
      || !Number.isInteger(batch.operationCount)
      || batch.operationCount < 0
      || batch.operationCount > operationCount
      || !Array.isArray(batch.completed)
      || batch.completed.length !== batch.operationCount
    ) {
      throw new Error("Invalid action result");
    }
    const refs = [];
    batch.completed.forEach(function (candidate, arrayIndex) {
      const completed = record(candidate);
      const allowedCompleted = ["index", "type", "status", "receipt"];
      if (
        Object.keys(completed).some(function (key) {
          return !allowedCompleted.includes(key);
        })
        || completed.index !== arrayIndex
        || !Object.hasOwn(ACTION_LABELS, completed.type)
        || completed.status !== "executed"
      ) {
        throw new Error("Invalid action result");
      }
      const receipt = record(completed.receipt);
      const allowedReceipt = [
        "verifiedByReadback",
        "manualVerificationRequired",
        "createdDraftRef",
        "sourceDraftRef",
        "sourceDraftRetention",
        "deliveryStatus",
        "deliveryConfirmed"
      ];
      if (Object.keys(receipt).some(function (key) {
        return !allowedReceipt.includes(key);
      })) {
        throw new Error("Invalid action result");
      }
      if (Object.hasOwn(receipt, "createdDraftRef")) {
        const reference = boundedString(receipt.createdDraftRef, 80);
        if (
          completed.type !== "gmail.create_draft"
          || !EVIDENCE_REF.test(reference)
        ) {
          throw new Error("Invalid action result");
        }
        refs.push(reference);
      }
    });
    return [...new Set(refs)];
  }

  function assertNoStoreEnvelope(value) {
    const authority = record(record(value).authority);
    if (
      !isRecord(value)
      || value.schema !== "hcn.console.actions.v1"
      || !validIsoInstant(value.generatedAt)
      || value.ephemeral !== true
      || value.cachePolicy !== "no_store"
      || authority.mode !== "explicit_signed_in_employee_approval"
      || authority.fileScope !== "assigned_only"
      || authority.automaticExecution !== false
      || authority.automaticRetry !== false
      || authority.providerIdentifiersExposed !== false
    ) {
      throw new Error("Invalid no-store response");
    }
  }

  function upsertPlanSummary(plans, plan) {
    const summary = {
      ...plan,
      operations: null
    };
    return [summary].concat(plans.filter(function (candidate) {
      return candidate.planId !== plan.planId;
    })).slice(0, 50);
  }

  function renderActionPlanList() {
    const plans = Array.isArray(state.actionPlans) ? state.actionPlans : [];
    setText(elements["approval-count"], String(plans.length));
    if (!plans.length) {
      renderWorkspaceEmpty(elements["approval-list"], "No action plans are available.");
      return;
    }
    const fragment = document.createDocumentFragment();
    plans.forEach(function (plan) {
      const button = document.createElement("button");
      const title = document.createElement("strong");
      const status = document.createElement("span");
      const expiry = document.createElement("span");
      button.type = "button";
      button.className = "approval-list-item";
      if (plan.planId === state.selectedPlanId) {
        button.classList.add("is-selected");
        button.setAttribute("aria-pressed", "true");
      } else {
        button.setAttribute("aria-pressed", "false");
      }
      button.disabled = state.actionLoading;
      setText(
        title,
        plan.fileDisplayLabel
          || plan.operationCount + " action" + (plan.operationCount === 1 ? "" : "s")
      );
      setText(status, humanize(plan.status) + " · " + plan.planId);
      setText(expiry, "Expires " + readableDateTime(plan.approvalExpiresAt));
      button.append(title, status, expiry);
      button.addEventListener("click", function () {
        loadActionPlanDetail(plan.planId);
      });
      fragment.append(button);
    });
    elements["approval-list"].replaceChildren(fragment);
  }

  function renderActionPlanDetail(plan) {
    elements["approval-placeholder"].hidden = true;
    elements["approval-detail"].hidden = false;
    setText(
      elements["approval-plan-title"],
      plan.operationCount + " exact action" + (plan.operationCount === 1 ? "" : "s")
    );
    badge(
      elements["approval-plan-state"],
      humanize(plan.status),
      planStatusTone(plan.status)
    );
    setText(elements["approval-plan-id"], plan.planId);
    setText(
      elements["approval-file-ref"],
      plan.fileDisplayLabel
        ? plan.fileDisplayLabel + " · " + plan.fileRef
        : plan.fileRef
    );
    setText(
      elements["approval-expires-at"],
      readableDateTime(plan.approvalExpiresAt) + " · " + plan.approvalExpiresAt
    );
    setText(elements["approval-digest"], plan.approvalDigest);
    const fragment = document.createDocumentFragment();
    plan.operations.forEach(function (operation) {
      const card = document.createElement("article");
      const heading = document.createElement("div");
      const title = document.createElement("strong");
      const number = document.createElement("span");
      card.className = "approval-operation";
      heading.className = "approval-operation-heading";
      setText(title, operation.action || ACTION_LABELS[operation.type]);
      setText(number, "Action " + (operation.index + 1));
      heading.append(title, number);
      card.append(heading, createMaterialList(operation.type, operation.material));
      fragment.append(card);
    });
    elements["approval-operations"].replaceChildren(fragment);
    elements["approval-acknowledge"].checked = false;
    syncExecutionControls();
  }

  function runtimeGateEnabled(key) {
    return record(record(record(state.meta).runtime).gates)[key] === "enabled";
  }

  function canExecuteSelectedPlan() {
    const plan = state.actionPlan;
    return Boolean(
      navigator.onLine
      && hasActionReadAuthority()
      && sessionCapabilities().includes(ACTION_EXECUTE_CAPABILITY)
      && runtimeGateEnabled("externalWrites")
      && runtimeGateEnabled("hcnActionExecution")
      && plan
      && plan.status === "pending"
      && Date.parse(plan.approvalExpiresAt) > Date.now()
      && !state.actionLoading
    );
  }

  function syncExecutionControls() {
    const plan = state.actionPlan;
    const executable = canExecuteSelectedPlan();
    const pending = Boolean(plan && plan.status === "pending");
    const canInvalidate = Boolean(
      navigator.onLine
      && pending
      && hasActionInvalidateAuthority()
      && !state.actionLoading
    );
    elements["approval-invalidate"].disabled = !canInvalidate;
    elements["approval-acknowledge"].disabled = !executable;
    if (!executable) elements["approval-acknowledge"].checked = false;
    elements["approval-execute"].disabled =
      !executable || !elements["approval-acknowledge"].checked;

    let message = "Choose one pending immutable plan before action-time approval.";
    if (plan && plan.status !== "pending") {
      message = "This plan is " + humanize(plan.status) + " and cannot be executed.";
    } else if (plan && Date.parse(plan.approvalExpiresAt) <= Date.now()) {
      message = "This approval expired. Prepare and review a fresh unchanged plan.";
    } else if (plan && !sessionCapabilities().includes(ACTION_EXECUTE_CAPABILITY)) {
      message = "This session does not have the exact action-execution capability.";
    } else if (plan && !runtimeGateEnabled("externalWrites")) {
      message = "The global external-writes gate is disabled.";
    } else if (plan && !runtimeGateEnabled("hcnActionExecution")) {
      message = "The separate HCN action-execution gate is disabled.";
    } else if (plan && executable) {
      message = "Both effect gates and the exact execution capability are enabled.";
    }
    setText(elements["execution-gate-message"], message);
  }

  async function invalidateSelectedPlan() {
    const plan = state.actionPlan;
    if (
      state.actionLoading
      || !plan
      || plan.status !== "pending"
      || !hasActionInvalidateAuthority()
    ) {
      return;
    }
    const controller = new AbortController();
    if (state.actionController) state.actionController.abort();
    state.actionController = controller;
    state.actionLoading = true;
    elements["approval-acknowledge"].checked = false;
    syncExecutionControls();
    notice(elements["approval-alert"], "Invalidating this pending plan.", "neutral");

    try {
      const response = await postOperationalJson(
        ENDPOINTS.actionInvalidate,
        { planId: plan.planId },
        controller.signal,
        ACTION_INVALIDATE_CAPABILITY
      );
      if (controller.signal.aborted) return;
      const updated = normalizePlanResponse(response, true);
      if (updated.planId !== plan.planId) throw new Error("Plan did not match");
      state.actionPlan = updated;
      state.actionPlans = upsertPlanSummary(state.actionPlans || [], updated);
      renderActionPlanList();
      renderActionPlanDetail(updated);
      notice(
        elements["approval-alert"],
        "The pending plan was invalidated. It cannot be executed.",
        "good"
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      if (isAuthorizationStatus(error)) {
        handleOperationalAuthLoss();
        return;
      }
      notice(
        elements["approval-alert"],
        actionPlanErrorMessage(error, "invalidate"),
        "bad"
      );
    } finally {
      if (state.actionController === controller) {
        state.actionController = null;
        state.actionLoading = false;
        renderActionPlanList();
        syncExecutionControls();
      }
    }
  }

  async function executeSelectedPlan() {
    const plan = state.actionPlan;
    if (state.actionLoading || !plan) {
      return;
    }
    if (!canExecuteSelectedPlan()) {
      syncExecutionControls();
      notice(
        elements["approval-alert"],
        "This plan is no longer executable. Prepare and review a fresh plan if needed.",
        "warn"
      );
      return;
    }
    if (elements["approval-acknowledge"].checked !== true) {
      return;
    }
    const planId = plan.planId;
    const controller = new AbortController();
    if (state.actionController) state.actionController.abort();
    state.actionController = controller;
    state.actionLoading = true;
    elements["approval-acknowledge"].checked = false;
    syncExecutionControls();
    badge(elements["approval-status"], "Executing", "neutral");
    notice(
      elements["approval-alert"],
      "Executing the exact acknowledged plan once. Do not repeat this action.",
      "warn"
    );
    let completed = false;

    try {
      await postOperationalJson(
        ENDPOINTS.actionExecute,
        { planId: planId },
        controller.signal,
        ACTION_EXECUTE_CAPABILITY
      );
      if (controller.signal.aborted) return;
      completed = true;
      notice(
        elements["approval-alert"],
        "The execution request completed. Refreshing plan and receipt metadata.",
        "good"
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      if (isAuthorizationStatus(error)) {
        handleOperationalAuthLoss();
        return;
      }
      notice(
        elements["approval-alert"],
        "The outcome could not be confirmed. Do not retry. Refresh receipts and reconcile against fresh JobNimbus evidence.",
        "bad"
      );
    } finally {
      if (state.actionController === controller) {
        state.actionController = null;
        state.actionLoading = false;
        renderActionPlanList();
        syncExecutionControls();
      }
    }
    if (completed) {
      await Promise.all([
        loadActionPlans({ selectPlanId: planId }),
        loadReceipts({ selectPlanId: planId })
      ]);
    }
  }

  async function loadReceipts(options) {
    if (state.receiptLoading || !hasReceiptReadAuthority() || !navigator.onLine) {
      return;
    }
    const requestedPlanId = PLAN_ID.test(String(options?.selectPlanId || ""))
      ? options.selectPlanId
      : state.selectedReceiptPlanId;
    if (state.receiptController) state.receiptController.abort();
    const controller = new AbortController();
    state.receiptController = controller;
    state.receiptLoading = true;
    elements["receipt-list"].setAttribute("aria-busy", "true");
    elements["receipt-refresh"].disabled = true;
    badge(elements["receipt-status"], "Loading", "neutral");
    notice(elements["receipt-alert"], "Loading durable receipt metadata.", "neutral");
    let detailPlanId = "";

    try {
      const response = await postOperationalJson(
        ENDPOINTS.receiptList,
        {},
        controller.signal,
        RECEIPT_READ_CAPABILITY
      );
      if (controller.signal.aborted) return;
      state.receipts = normalizeReceiptListResponse(response);
      const selected = state.receipts.find(function (receipt) {
        return receipt.planId === requestedPlanId;
      }) || state.receipts[0];
      state.selectedReceiptPlanId = selected ? selected.planId : null;
      state.receipt = null;
      renderReceiptList();
      if (selected) {
        detailPlanId = selected.planId;
      } else {
        purgeReceiptDetailDom();
      }
      badge(
        elements["receipt-status"],
        state.receipts.length + " receipt" + (state.receipts.length === 1 ? "" : "s"),
        "good"
      );
      notice(
        elements["receipt-alert"],
        state.receipts.length
          ? "Choose a receipt to inspect its bounded outcome metadata."
          : "There are no durable receipts for this HCN operator.",
        "good"
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      if (isAuthorizationStatus(error)) {
        handleOperationalAuthLoss();
        return;
      }
      state.receipts = null;
      state.selectedReceiptPlanId = null;
      state.receipt = null;
      renderWorkspaceEmpty(
        elements["receipt-list"],
        "Receipt metadata could not be loaded. No stale list is shown."
      );
      purgeReceiptDetailDom();
      badge(elements["receipt-status"], "Unavailable", "bad");
      notice(elements["receipt-alert"], receiptErrorMessage(error), "bad");
    } finally {
      if (state.receiptController === controller) {
        state.receiptController = null;
        state.receiptLoading = false;
        elements["receipt-list"].setAttribute("aria-busy", "false");
        elements["receipt-refresh"].disabled = false;
        renderReceiptList();
      }
    }
    if (detailPlanId && hasReceiptReadAuthority()) {
      await loadReceiptDetail(detailPlanId);
    }
  }

  async function loadReceiptDetail(planId) {
    if (
      state.receiptLoading
      || !hasReceiptReadAuthority()
      || !PLAN_ID.test(String(planId || ""))
    ) {
      return;
    }
    if (state.receiptController) state.receiptController.abort();
    const controller = new AbortController();
    state.receiptController = controller;
    state.receiptLoading = true;
    state.selectedReceiptPlanId = planId;
    state.receipt = null;
    renderReceiptList();
    purgeReceiptDetailDom();
    notice(elements["receipt-alert"], "Loading exact receipt metadata.", "neutral");

    try {
      const response = await postOperationalJson(
        ENDPOINTS.receiptDetail,
        { planId: planId },
        controller.signal,
        RECEIPT_READ_CAPABILITY
      );
      if (controller.signal.aborted) return;
      const receipt = normalizeReceiptResponse(response);
      if (receipt.planId !== planId) throw new Error("Receipt did not match");
      state.receipt = receipt;
      state.receipts = upsertReceipt(state.receipts || [], receipt);
      renderReceiptList();
      renderReceiptDetail(receipt);
      const receiptNotice = receiptOutcomeNotice(receipt.status);
      notice(
        elements["receipt-alert"],
        receiptNotice.message,
        receiptNotice.tone
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      if (isAuthorizationStatus(error)) {
        handleOperationalAuthLoss();
        return;
      }
      state.receipt = null;
      purgeReceiptDetailDom();
      notice(elements["receipt-alert"], receiptErrorMessage(error), "bad");
    } finally {
      if (state.receiptController === controller) {
        state.receiptController = null;
        state.receiptLoading = false;
        renderReceiptList();
      }
    }
  }

  function normalizeReceiptListResponse(value) {
    assertNoStoreEnvelope(value);
    if (!Array.isArray(value.receipts)) {
      throw new Error("Invalid receipt list");
    }
    return value.receipts.slice(0, 100).map(normalizeReceipt);
  }

  function normalizeReceiptResponse(value) {
    assertNoStoreEnvelope(value);
    const receipt = record(value.receipt);
    if (!Object.keys(receipt).length) throw new Error("Invalid receipt response");
    return normalizeReceipt(receipt);
  }

  function normalizeReceipt(value) {
    const receipt = record(value);
    const fileRef = boundedString(receipt.fileRef, 80);
    const planId = boundedString(receipt.planId, 80);
    const digest = boundedString(receipt.digest, 80);
    const batchRef = boundedString(receipt.batchRef, 80);
    const status = boundedString(receipt.status, 64);
    const counts = [
      receipt.succeededCount,
      receipt.failedCount,
      receipt.blockedCount,
      receipt.unknownCount
    ];
    if (
      !FILE_REF.test(fileRef)
      || !PLAN_ID.test(planId)
      || !APPROVAL_DIGEST.test(digest)
      || !BATCH_REF.test(batchRef)
      || !RECEIPT_STATUSES.has(status)
      || !Number.isInteger(receipt.operationCount)
      || receipt.operationCount < 1
      || receipt.operationCount > MAX_ACTIONS
      || counts.some(function (count) {
        return !Number.isInteger(count) || count < 0 || count > MAX_ACTIONS;
      })
      || counts.reduce(function (sum, count) {
        return sum + count;
      }, 0) !== receipt.operationCount
      || !validIsoInstant(receipt.createdAt)
      || !validIsoInstant(receipt.updatedAt)
      || !validIsoInstant(receipt.executingAt)
      || (
        receipt.terminalAt !== undefined
        && !validIsoInstant(receipt.terminalAt)
      )
    ) {
      throw new Error("Invalid receipt metadata");
    }
    return {
      fileRef: fileRef,
      planId: planId,
      digest: digest,
      batchRef: batchRef,
      status: status,
      operationCount: receipt.operationCount,
      succeededCount: receipt.succeededCount,
      failedCount: receipt.failedCount,
      blockedCount: receipt.blockedCount,
      unknownCount: receipt.unknownCount,
      createdAt: receipt.createdAt,
      updatedAt: receipt.updatedAt,
      executingAt: receipt.executingAt,
      terminalAt: receipt.terminalAt || ""
    };
  }

  function upsertReceipt(receipts, receipt) {
    return [receipt].concat(receipts.filter(function (candidate) {
      return candidate.planId !== receipt.planId;
    })).slice(0, 100);
  }

  function renderReceiptList() {
    const receipts = Array.isArray(state.receipts) ? state.receipts : [];
    setText(elements["receipt-count"], String(receipts.length));
    if (!receipts.length) {
      renderWorkspaceEmpty(elements["receipt-list"], "No receipt metadata is available.");
      return;
    }
    const fragment = document.createDocumentFragment();
    receipts.forEach(function (receipt) {
      const button = document.createElement("button");
      const title = document.createElement("strong");
      const status = document.createElement("span");
      const updated = document.createElement("span");
      button.type = "button";
      button.className = "receipt-list-item";
      if (receipt.planId === state.selectedReceiptPlanId) {
        button.classList.add("is-selected");
        button.setAttribute("aria-pressed", "true");
      } else {
        button.setAttribute("aria-pressed", "false");
      }
      button.disabled = state.receiptLoading;
      setText(title, humanize(receipt.status));
      setText(status, receipt.operationCount + " action outcome · " + receipt.planId);
      setText(updated, "Updated " + readableDateTime(receipt.updatedAt));
      button.append(title, status, updated);
      button.addEventListener("click", function () {
        loadReceiptDetail(receipt.planId);
      });
      fragment.append(button);
    });
    elements["receipt-list"].replaceChildren(fragment);
  }

  function renderReceiptDetail(receipt) {
    elements["receipt-placeholder"].hidden = true;
    elements["receipt-detail"].hidden = false;
    setText(elements["receipt-detail-heading"], receipt.batchRef);
    badge(
      elements["receipt-detail-state"],
      humanize(receipt.status),
      planStatusTone(receipt.status)
    );
    const rows = [
      ["Plan", receipt.planId, false],
      ["File", receipt.fileRef, false],
      ["Batch", receipt.batchRef, false],
      ["Status", humanize(receipt.status), false],
      ["Operation count", String(receipt.operationCount), false],
      ["Succeeded", String(receipt.succeededCount), false],
      ["Failed", String(receipt.failedCount), false],
      ["Blocked", String(receipt.blockedCount), false],
      ["Unknown", String(receipt.unknownCount), false],
      ["Execution started", readableDateTime(receipt.executingAt), false],
      [
        receipt.terminalAt ? "Terminal at" : "Last updated",
        readableDateTime(receipt.terminalAt || receipt.updatedAt),
        false
      ],
      ["Approval digest", receipt.digest, true]
    ];
    const fragment = document.createDocumentFragment();
    rows.forEach(function (row) {
      const wrapper = document.createElement("div");
      const term = document.createElement("dt");
      const detail = document.createElement("dd");
      if (row[2]) wrapper.dataset.wide = "true";
      setText(term, row[0]);
      setText(detail, row[1]);
      wrapper.append(term, detail);
      fragment.append(wrapper);
    });
    elements["receipt-detail-fields"].replaceChildren(fragment);
  }

  function validIsoInstant(value) {
    if (typeof value !== "string" || value.length > 40) return false;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
  }

  function planStatusTone(status) {
    if (status === "executed") return "good";
    if (
      status === "completed_pending_verification"
      || status === "executing"
      || status === "blocked_duplicate"
    ) return "warn";
    if (
      status === "failed"
      || status === "partial_failure"
      || status === "reconciliation_required"
    ) {
      return "bad";
    }
    return "neutral";
  }

  function receiptOutcomeNotice(status) {
    if (status === "executed") {
      return {
        message: "Readback-confirmed execution metadata loaded.",
        tone: "good"
      };
    }
    if (status === "completed_pending_verification") {
      return {
        message:
          "The actions were accepted, but fresh JobNimbus verification is still required. Do not repeat them.",
        tone: "warn"
      };
    }
    if (status === "executing") {
      return {
        message:
          "Execution has no terminal receipt yet. Do not retry; reconcile against fresh source evidence.",
        tone: "warn"
      };
    }
    if (status === "reconciliation_required") {
      return {
        message:
          "This outcome requires reconciliation against fresh source evidence. Do not retry it.",
        tone: "warn"
      };
    }
    if (status === "partial_failure" || status === "failed") {
      return {
        message:
          "The batch did not fully complete. Review fresh evidence and its receipt before any new action.",
        tone: "bad"
      };
    }
    if (status === "blocked_duplicate") {
      return {
        message:
          "A duplicate execution was blocked. Review the prior durable outcome before any new action.",
        tone: "warn"
      };
    }
    return {
      message: "Durable outcome metadata loaded. No retry is assumed.",
      tone: "neutral"
    };
  }

  function actionPlanErrorMessage(error, action) {
    const status = statusOf(error);
    if (status === 409) {
      return "The plan or exact file scope changed. Prepare and review a fresh plan.";
    }
    if (status === 429) {
      return "The action control plane is busy. Wait before making a fresh request.";
    }
    if (status === 502 || status === 503 || status === 507) {
      return "The action control plane is unavailable. No action is assumed.";
    }
    return "The action plan could not " + (
      action === "prepare" ? "be prepared." : action + " safely."
    );
  }

  function receiptErrorMessage(error) {
    const status = statusOf(error);
    if (status === 404) {
      return "That receipt is not available for this HCN operator.";
    }
    if (status === 502 || status === 503 || status === 507) {
      return "Durable receipt metadata is unavailable. No outcome is assumed.";
    }
    return "Receipt metadata could not be verified.";
  }

  function handleOperationalAuthLoss() {
    clearOperationalData("The operational session is no longer authorized.");
    state.session = null;
    state.sessionError = { status: 401 };
    renderSignedOut("Sign in again to verify your exact operating scope.");
    renderOperationsLocked(
      "Session expired",
      "Client data was cleared. Sign in again before requesting fresh evidence."
    );
    renderOverallState();
  }

  function isAuthorizationStatus(error) {
    return statusOf(error) === 401 || statusOf(error) === 403;
  }

  function workCenterErrorMessage(error) {
    if (!navigator.onLine) return "The connection went offline. No client queue is retained.";
    if (statusOf(error) === 502 || statusOf(error) === 503) {
      return "Fresh JobNimbus evidence is unavailable. Try the queue again.";
    }
    return "The Work Center could not verify a fresh assigned-file queue.";
  }

  function managementSweepErrorMessage(error) {
    if (!navigator.onLine) {
      return "The connection went offline. No company report is retained.";
    }
    if (statusOf(error) === 409) {
      return "The eligible-file set changed while the report was running. Run a fresh sweep.";
    }
    if (statusOf(error) === 422) {
      return "The management sweep could not verify its eligibility or ownership rules.";
    }
    if (statusOf(error) === 502 || statusOf(error) === 503) {
      return "One or more live sources are unavailable. No stale management report is shown.";
    }
    return "The company management sweep could not be completed from fresh evidence.";
  }

  function fileErrorMessage(error) {
    if (!navigator.onLine) return "The connection went offline. File evidence was cleared.";
    if (statusOf(error) === 404) {
      return "That file is no longer in your current assigned queue. Refresh the queue.";
    }
    if (statusOf(error) === 502 || statusOf(error) === 503) {
      return "Fresh file evidence is unavailable. Try this exact file again.";
    }
    return "The exact file review could not be completed from fresh evidence.";
  }

  function renderCapabilityGroups(capabilities) {
    const groups = new Map();
    capabilities.forEach(function (capability) {
      const prefix = capability.split(".", 1)[0];
      groups.set(prefix, (groups.get(prefix) || 0) + 1);
    });

    const fragment = document.createDocumentFragment();
    Array.from(groups.entries()).sort(function (a, b) {
      return a[0].localeCompare(b[0]);
    }).forEach(function (entry) {
      const item = document.createElement("span");
      const label = document.createElement("span");
      const count = document.createElement("strong");
      item.className = "capability-group";
      setText(label, CAPABILITY_GROUP_LABELS[entry[0]] || humanize(entry[0]));
      setText(count, String(entry[1]));
      item.append(label, count);
      fragment.append(item);
    });

    elements["capability-groups"].replaceChildren(fragment);
  }

  function renderOverallState() {
    syncHomeGuidance();
    const metaReady = Boolean(state.meta) && !state.metaError;
    const sessionDenied = state.sessionError &&
      (statusOf(state.sessionError) === 401 || statusOf(state.sessionError) === 403);
    const sessionAuthorized = Boolean(
      state.session &&
      state.session.authenticated === true &&
      record(state.session.identity).authentication === "authenticated"
    );
    const sessionNeedsSignIn = sessionDenied || (Boolean(state.session) && !sessionAuthorized);
    const sessionReady = sessionAuthorized || sessionNeedsSignIn;

    if (!navigator.onLine) {
      setConnection("offline", "Offline");
      setText(elements["load-message"], "You are offline. Only the console shell may be available.");
      setText(elements["readiness-score"], "OFF");
      setText(elements["readiness-label"], "Connection unavailable");
      setText(elements["readiness-summary"], "Reconnect to verify fresh bridge and session status.");
      return;
    }

    if (metaReady && sessionReady) {
      setConnection("good", "System ready");
      setText(
        elements["load-message"],
        sessionNeedsSignIn
          ? "System verified. Sign in to check your operating permissions."
          : "Fresh platform and session checks complete."
      );
      setText(elements["readiness-score"], sessionNeedsSignIn ? "1/2" : "2/2");
      setText(
        elements["readiness-label"],
        sessionNeedsSignIn ? "System ready · sign in next" : "Controlled operations ready"
      );
      setText(
        elements["readiness-summary"],
        sessionNeedsSignIn
          ? "The platform foundation is responding. Your authority remains closed until you sign in."
          : "HCN and your account access have been checked. Work views still request fresh client data when you use them."
      );
      return;
    }

    setConnection("error", "Needs attention");
    setText(elements["load-message"], "One or more readiness checks could not be completed.");
    setText(elements["readiness-score"], "—");
    setText(elements["readiness-label"], "Readiness incomplete");
    setText(
      elements["readiness-summary"],
      "The console will not assume missing connector, gate, build, or authority information."
    );
  }

  function renderStatusItems(container, entries, toneForValue) {
    if (!entries.length) {
      renderEmpty(container, "No status fields were reported.");
      return;
    }

    const fragment = document.createDocumentFragment();
    entries.forEach(function (entry) {
      const item = document.createElement("div");
      const dot = document.createElement("span");
      const copy = document.createElement("span");
      const label = document.createElement("strong");
      const value = document.createElement("span");

      item.className = "status-item";
      item.dataset.tone = toneForValue(entry.value);
      dot.className = "status-item-dot";
      dot.setAttribute("aria-hidden", "true");
      copy.className = "status-item-copy";
      setText(label, entry.label);
      setText(value, humanize(entry.value || "unknown"));
      copy.append(label, value);
      item.append(dot, copy);
      fragment.append(item);
    });

    container.replaceChildren(fragment);
  }

  function renderEmpty(container, message) {
    const paragraph = document.createElement("p");
    paragraph.className = "empty-state";
    setText(paragraph, message);
    container.replaceChildren(paragraph);
  }

  function knownEntries(source, labels) {
    return Object.keys(labels).map(function (key) {
      return {
        key: key,
        label: labels[key],
        value: stringValue(source[key]) || "unknown"
      };
    });
  }

  function connectorTone(value) {
    if (value === "configured") return "good";
    if (value === "unconfigured") return "bad";
    return "neutral";
  }

  function gateTone(value) {
    if (value === "enabled") return "warn";
    if (value === "disabled") return "good";
    return "neutral";
  }

  function notice(element, message, tone) {
    setText(element, message);
    element.dataset.tone = tone;
  }

  function badge(element, message, tone) {
    setText(element, message);
    element.dataset.tone = tone;
  }

  function setConnection(tone, message) {
    elements["connection-status"].dataset.tone = tone;
    setText(elements["connection-status-text"], message);
  }

  function handleNetworkChange() {
    if (navigator.onLine) {
      loadPlatformState();
    } else {
      cancelManagementSweepExpiryTimer();
      clearOperationalData("Client data was cleared when the connection went offline.");
      renderOperationsLocked(
        "Offline",
        "Reconnect to verify the session and request fresh evidence."
      );
      renderOverallState();
      syncAssistantAccess();
    }
  }

  function handleVisibilityChange() {
    enforceSessionDeadline();
    enforceManagementSweepExpiry();
  }

  function readableTime(value) {
    if (typeof value !== "string" || !value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit"
    }).format(date);
  }

  function readableDateTime(value) {
    if (typeof value !== "string" || !value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }).format(date);
  }

  function readableCentralDateTime(value) {
    if (typeof value !== "string" || !value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat(undefined, {
      timeZone: "America/Chicago",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short"
    }).format(date);
  }

  function humanize(value) {
    return String(value || "unknown")
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, function (letter) {
        return letter.toUpperCase();
      });
  }

  function sweepSourceLabel(value) {
    const normalized = boundedString(value, 64).toLowerCase();
    return SWEEP_SOURCE_LABELS[normalized] || humanize(normalized);
  }

  function statusOf(error) {
    return error && Number.isInteger(error.status) ? error.status : null;
  }

  function stringValue(value) {
    return typeof value === "string" && value.length <= 240 ? value : "";
  }

  function boundedString(value, maximum) {
    if (typeof value !== "string") return "";
    return Array.from(value).slice(0, maximum).join("");
  }

  function record(value) {
    return isRecord(value) ? value : {};
  }

  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function setText(element, value) {
    element.textContent = String(value);
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/hcn/sw.js?shell=v11", { scope: "/hcn/" }).catch(function () {
        // Offline support is optional; readiness remains sourced from live API checks.
      });
    });
  }
})();
