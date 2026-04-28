const DEFAULT_LOCAL_BACKEND_HOST = "127.0.0.1";
const DEFAULT_LOCAL_BACKEND_PORT = 43817;

const resolveBackendPort = () => {
  if (typeof window === "undefined") {
    return DEFAULT_LOCAL_BACKEND_PORT;
  }

  try {
    const electronBackendConfig = window.electronAPI?.getBackendConfig?.();
    const candidatePort = Number(electronBackendConfig?.port);
    if (Number.isInteger(candidatePort) && candidatePort > 0 && candidatePort <= 65535) {
      return candidatePort;
    }
  } catch { }

  return DEFAULT_LOCAL_BACKEND_PORT;
};

const resolveBackendHost = () => {
  if (typeof window === "undefined") {
    return DEFAULT_LOCAL_BACKEND_HOST;
  }

  const hostname = (window.location.hostname || "").trim();

  if (window.location.protocol === "file:" || !hostname) {
    return DEFAULT_LOCAL_BACKEND_HOST;
  }

  return hostname;
};

const sleep = (delayMs) =>
  new Promise((resolve) => {
    window.setTimeout(resolve, delayMs);
  });

const backendHost = resolveBackendHost();
const backendPort = resolveBackendPort();

export const backendHttpUrl = `http://${backendHost}:${backendPort}`;
export const backendWsBaseUrl = `ws://${backendHost}:${backendPort}`;

export async function waitForBackendReady({
  attempts = 20,
  delayMs = 500,
} = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${backendHttpUrl}/api/health`, {
        cache: "no-store",
      });

      if (response.ok) {
        return true;
      }
    } catch { }

    if (attempt < attempts - 1) {
      await sleep(delayMs);
    }
  }

  return false;
}

export function createTelemetryWebSocket() {
  return new WebSocket(`${backendWsBaseUrl}/ws/telemetry`);
}

const requestMeasurement = async (path, method = "GET", body) => {
  try {
    const requestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
      },
      cache: "no-store",
    };

    if (body !== undefined) {
      requestInit.body = JSON.stringify(body);
    }

    const response = await fetch(`${backendHttpUrl}${path}`, {
      ...requestInit,
    });

    if (!response.ok) {
      return null;
    }

    const payload = await response.json();
    return {
      status: payload.status || "idle",
      elapsedSeconds: Number(payload.elapsedSeconds || 0),
    };
  } catch {
    return null;
  }
};

export const getMeasurementStatus = () =>
  requestMeasurement("/api/measurement/status");
export const startMeasurement = (payload) =>
  requestMeasurement("/api/measurement/start", "POST", payload);
export const pauseMeasurement = () =>
  requestMeasurement("/api/measurement/pause", "POST");
export const resumeMeasurement = () =>
  requestMeasurement("/api/measurement/resume", "POST");
export const stopMeasurement = () =>
  requestMeasurement("/api/measurement/stop", "POST");
export const updateMeasurementConfig = (payload) =>
  requestMeasurement("/api/measurement/config", "POST", payload);

export async function saveMission(mission) {
  try {
    const response = await fetch(`${backendHttpUrl}/api/missions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      cache: "no-store",
      body: JSON.stringify(mission),
    });

    if (!response.ok) {
      return null;
    }

    return response.json();
  } catch {
    return null;
  }
}

export async function updateMission(missionId, mission) {
  if (!missionId) {
    return null;
  }

  try {
    const response = await fetch(
      `${backendHttpUrl}/api/missions/${encodeURIComponent(missionId)}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        cache: "no-store",
        body: JSON.stringify(mission),
      },
    );

    if (!response.ok) {
      return null;
    }

    return response.json();
  } catch {
    return null;
  }
}

export async function listMissions() {
  try {
    const response = await fetch(`${backendHttpUrl}/api/missions`, {
      cache: "no-store",
    });

    if (!response.ok) {
      return [];
    }

    const payload = await response.json();
    return Array.isArray(payload?.data) ? payload.data : [];
  } catch {
    return [];
  }
}

export async function listTelemetryHistory({ limit = 100000, from, to } = {}) {
  try {
    const query = new URLSearchParams();
    if (Number.isFinite(limit) && limit > 0) {
      query.set("limit", String(Math.floor(limit)));
    }
    if (typeof from === "string" && from.trim()) {
      query.set("from", from.trim());
    }
    if (typeof to === "string" && to.trim()) {
      query.set("to", to.trim());
    }

    const response = await fetch(
      `${backendHttpUrl}/api/telemetry/history${query.size ? `?${query.toString()}` : ""}`,
      {
        cache: "no-store",
      },
    );

    if (!response.ok) {
      return [];
    }

    const payload = await response.json();
    return Array.isArray(payload?.data) ? payload.data : [];
  } catch {
    return [];
  }
}

export async function deleteMission(missionId) {
  if (!missionId) {
    return false;
  }

  try {
    const response = await fetch(
      `${backendHttpUrl}/api/missions/${encodeURIComponent(missionId)}`,
      {
        method: "DELETE",
        cache: "no-store",
      },
    );

    return response.ok;
  } catch {
    return false;
  }
}

export async function deleteAllData() {
  try {
    const response = await fetch(`${backendHttpUrl}/api/data`, {
      method: "DELETE",
      cache: "no-store",
    });

    return response.ok;
  } catch {
    return false;
  }
}

export async function syncAndPullData() {
  try {
    const response = await fetch(`${backendHttpUrl}/api/data/sync`, {
      method: "POST",
      cache: "no-store",
    });

    return response.ok;
  } catch {
    return false;
  }
}

export async function runAerisAnalysis(payload) {
  try {
    const backendReady = await waitForBackendReady({
      attempts: 6,
      delayMs: 250,
    });

    if (!backendReady) {
      return {
        ok: false,
        error: `Backend analysis service is not reachable at ${backendHttpUrl}`,
      };
    }

    const requestBody = JSON.stringify(payload || {});
    const response = await fetch(`${backendHttpUrl}/api/aeris/analyze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      cache: "no-store",
      body: requestBody,
    });

    const responsePayload = await response.json().catch(() => null);

    if (!response.ok) {
      return {
        ok: false,
        error:
          responsePayload?.error || "Failed to run Aeris notebook analysis",
      };
    }

    return {
      ok: Boolean(responsePayload?.ok),
      outputText: String(responsePayload?.outputText || ""),
      imageDataUri:
        typeof responsePayload?.imageDataUri === "string" &&
          responsePayload.imageDataUri
          ? responsePayload.imageDataUri
          : null,
      imageDataUris: Array.isArray(responsePayload?.imageDataUris)
        ? responsePayload.imageDataUris.filter(
          (value) => typeof value === "string" && value,
        )
        : typeof responsePayload?.imageDataUri === "string" &&
          responsePayload.imageDataUri
          ? [responsePayload.imageDataUri]
          : [],
      executionCount: responsePayload?.executionCount ?? null,
      cellIndex: responsePayload?.cellIndex ?? null,
      executedAt: responsePayload?.executedAt || null,
      pythonCommand: responsePayload?.pythonCommand || null,
    };
  } catch (error) {
    const message =
      error instanceof Error && error.message
        ? error.message
        : "Unknown request failure";

    return {
      ok: false,
      error: `Unable to reach backend analysis endpoint: ${message}`,
    };
  }
}

export async function pythonDataSender() {
  const dataset = {
    users: [{ id: 1, name: "Alice" }],
    sentAt: new Date().toISOString(),
  };

  try {
    const response = await fetch("http://127.0.0.1:5000/process_data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(dataset),
    });

    const rawBody = await response.text();

    if (!response.ok) {
      const errorMessage = `[test] HTTP error ${response.status} ${response.statusText}`;
      console.error(errorMessage);
      console.error("[test] Raw response:", rawBody || "<empty>");
      return { ok: false, error: errorMessage, rawBody };
    }

    if (!rawBody) {
      const errorMessage = "[test] Empty response body from /process_data";
      console.error(errorMessage);
      return { ok: false, error: errorMessage };
    }

    let data;
    try {
      data = JSON.parse(rawBody);
    } catch {
      const errorMessage = "[test] Response was not valid JSON";
      console.error(errorMessage, rawBody);
      return { ok: false, error: errorMessage, rawBody };
    }

    console.log("[test] Success:", data);
    return { ok: true, data };
  } catch (error) {
    const errorMessage = `[test] Request failed: ${error.message}`;
    console.error(errorMessage);
    return { ok: false, error: errorMessage };
  }
}



// List available COM ports from backend
export async function getCOMPorts() {
  try {
    const response = await fetch(`${backendHttpUrl}/api/com-ports`, { cache: "no-store" });
    if (!response.ok) return [];
    const ports = await response.json();
    // Return array of { path, friendlyName, manufacturer }
    return ports;
  } catch {
    return [];
  }
}
