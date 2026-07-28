(function () {
  "use strict";

  const ENDPOINTS = Object.freeze({
    meta: "/api/v1/meta",
    session: "/hcn/auth/session",
    logout: "/hcn/auth/logout"
  });

  const CONNECTOR_LABELS = Object.freeze({
    carrierFollowUp: "Carrier follow-up",
    claimFiling: "Claim filing",
    clientCoordinator: "Client coordinator",
    gmail: "Gmail",
    googleCalendar: "Google Calendar",
    googleOAuth: "Google sign-in",
    jobNimbus: "JobNimbus",
    quo: "Quo",
    realtimeVoice: "Realtime voice"
  });

  const GATE_LABELS = Object.freeze({
    carrierFollowUpCalls: "Carrier follow-up calls",
    claimFilingCalls: "Claim filing calls",
    clientCoordinatorAppointmentCalls: "Appointment calls",
    clientCoordinatorExpandedCalls: "Expanded coordinator calls",
    externalWrites: "External writes",
    gmailSend: "Gmail sending",
    quoSend: "Quo sending",
    realtimeVoiceCalls: "Realtime voice calls"
  });

  const BOUNDARY_LABELS = Object.freeze({
    chanceBrain: {
      title: "Chance Brain",
      states: {
        legacy_read_only_non_operator_paths: "Legacy compatibility · read only"
      }
    },
    hcnV2ChanceBrainDataFlow: {
      title: "HCN v2 → Chance Brain",
      states: {
        disconnected: "Disconnected · no data flow"
      }
    },
    jobrolo: {
      title: "Jobrolo",
      states: {
        disconnected: "Disconnected · separate product"
      }
    },
    hcnOperationsBrain: {
      title: "HCN Operations Brain",
      states: {
        v2_foundation: "V2 foundation · HCN only"
      }
    },
    legacyClientMemory: {
      title: "Legacy client memory",
      states: {
        migration_required: "Restricted · migration required"
      }
    }
  });

  const CAPABILITY_GROUP_LABELS = Object.freeze({
    brain: "Advisory",
    claims: "Claims",
    gmail: "Gmail",
    handoff: "Handoffs",
    identity: "Identity",
    jobnimbus: "JobNimbus",
    memory: "Memory controls",
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
    sessionError: null
  };

  const elements = {};

  document.addEventListener("DOMContentLoaded", initialize);

  function initialize() {
    [
      "connection-status",
      "connection-status-text",
      "sign-in-action",
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
      "freshness-text"
    ].forEach(function (id) {
      elements[id] = document.getElementById(id);
    });

    elements["retry-action"].addEventListener("click", loadPlatformState);
    elements["sign-out-action"].addEventListener("click", signOut);
    window.addEventListener("online", handleNetworkChange);
    window.addEventListener("offline", handleNetworkChange);

    loadPlatformState();
    registerServiceWorker();
  }

  async function loadPlatformState() {
    if (state.loading) return;
    state.loading = true;
    state.metaError = null;
    state.sessionError = null;
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

    state.loading = false;
    elements["retry-action"].disabled = false;
    renderOverallState();
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

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new Error("Unexpected response format");
    }

    const data = await response.json();
    if (!isRecord(data)) throw new Error("Invalid response");
    return data;
  }

  function setLoadingView() {
    elements["retry-action"].disabled = true;
    elements["sign-in-action"].hidden = true;
    elements["sign-out-action"].hidden = true;
    setConnection("pending", "Checking");
    setText(elements["load-message"], "Checking fresh platform and session metadata…");
  }

  function renderMeta(meta) {
    const runtime = record(meta.runtime);
    renderConnectors(record(runtime.connectors));
    renderGates(record(runtime.gates), record(runtime.configurationDrift));
    renderBoundaries(record(meta.boundaries));
    renderBuild(record(meta.build));

    const generatedAt = readableTime(meta.generatedAt);
    setText(
      elements["freshness-text"],
      generatedAt
        ? "Platform metadata checked " + generatedAt + "."
        : "Platform metadata received; timestamp unavailable."
    );
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
    renderEmpty(elements["boundary-list"], "System boundaries could not be verified.");
    renderBuildPlaceholder("Metadata unavailable");
    setText(
      elements["freshness-text"],
      statusOf(error) ? "Platform check returned status " + statusOf(error) + "." : "Platform check failed."
    );
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

  function renderBoundaries(boundaries) {
    const fragment = document.createDocumentFragment();

    Object.keys(BOUNDARY_LABELS).forEach(function (key) {
      const specification = BOUNDARY_LABELS[key];
      const value = stringValue(boundaries[key]) || "unknown";
      const item = document.createElement("div");
      item.className = "boundary-item";

      const copy = document.createElement("div");
      const title = document.createElement("strong");
      const status = document.createElement("span");
      const mark = document.createElement("i");

      setText(title, specification.title);
      setText(status, specification.states[value] || humanize(value));
      mark.className = "boundary-state";
      mark.setAttribute("aria-hidden", "true");
      if (value === "migration_required" || value === "unknown") {
        mark.dataset.tone = "warn";
      }

      copy.append(title, status);
      item.append(copy, mark);
      fragment.append(item);
    });

    elements["boundary-list"].replaceChildren(fragment);
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

    const identityType = stringValue(identity.type);
    const role = stringValue(identity.role) || "authorized operator";
    const scope = stringValue(identity.jobNimbusScope) || "defined";
    const identityLabel = identityType === "hcn_browser_session"
      ? "HCN browser session"
      : identityType === "google_oauth"
        ? "Google session"
        : "HP operator";

    elements["sign-in-action"].hidden = true;
    elements["sign-out-action"].hidden = false;
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
    elements["sign-in-action"].hidden = false;
    elements["sign-out-action"].hidden = true;
    badge(elements["identity-badge"], "Sign in required", "neutral");
    setText(elements["capability-metric"], "Sign in");
    setText(elements["capability-metric-detail"], "Authority not assumed");
    setText(elements["capability-summary"], message);
    elements["capability-groups"].replaceChildren();
  }

  async function signOut() {
    const browserSession = record(record(state.session).browserSession);
    const csrfToken = stringValue(browserSession.csrfToken);
    if (!csrfToken) {
      await loadPlatformState();
      return;
    }

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
      setConnection("good", "Bridge ready");
      setText(
        elements["load-message"],
        sessionNeedsSignIn
          ? "Bridge verified. Sign in to check your operating permissions."
          : "Fresh platform and session checks complete."
      );
      setText(elements["readiness-score"], sessionNeedsSignIn ? "1/2" : "2/2");
      setText(
        elements["readiness-label"],
        sessionNeedsSignIn ? "Bridge ready · sign in next" : "Foundation ready"
      );
      setText(
        elements["readiness-summary"],
        sessionNeedsSignIn
          ? "The platform foundation is responding. Your authority remains closed until you sign in."
          : "The bridge, system boundaries, and your route-level authority have been checked fresh."
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
      renderOverallState();
    }
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

  function humanize(value) {
    return String(value || "unknown")
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, function (letter) {
        return letter.toUpperCase();
      });
  }

  function statusOf(error) {
    return error && Number.isInteger(error.status) ? error.status : null;
  }

  function stringValue(value) {
    return typeof value === "string" && value.length <= 240 ? value : "";
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
      navigator.serviceWorker.register("/hcn/sw.js", { scope: "/hcn/" }).catch(function () {
        // Offline support is optional; readiness remains sourced from live API checks.
      });
    });
  }
})();
