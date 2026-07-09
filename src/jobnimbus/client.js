export class ReadOnlyJobNimbusClient {
  constructor(config) {
    this.config = config;
  }

  async getJson(endpoint, query = {}) {
    return this.requestJson("GET", endpoint, { query });
  }

  async postJson(endpoint, body, query = {}) {
    return this.requestJson("POST", endpoint, { query, body });
  }

  async putJson(endpoint, body, query = {}) {
    return this.requestJson("PUT", endpoint, { query, body });
  }

  async requestJson(method, endpoint, options = {}) {
    if (!this.config.apiBaseUrl) {
      throw new Error("JOBNIMBUS_API_BASE_URL is required for live API mode.");
    }
    if (!this.config.apiKey) {
      throw new Error("JOBNIMBUS_API_KEY is required for live API mode.");
    }

    const url = new URL(`${this.config.apiBaseUrl}${ensureLeadingSlash(endpoint)}`);
    if (this.config.actor) {
      url.searchParams.set("actor", this.config.actor);
    }
    for (const [key, value] of Object.entries(options.query || {})) {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    const headers = {
      "accept": "application/json",
      "authorization": `${this.config.authScheme} ${this.config.apiKey}`
    };

    const request = {
      method,
      headers
    };

    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      request.body = JSON.stringify(options.body);
    }

    const response = await fetch(url, {
      method,
      headers,
      body: request.body
    });

    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text.slice(0, 2000) };
    }

    if (!response.ok) {
      throw new Error(`${method} ${endpoint} failed with ${response.status}: ${JSON.stringify(body).slice(0, 500)}`);
    }

    return body;
  }

  async listResource(name, endpoint, query = {}) {
    const result = await this.listResourceWithMeta(name, endpoint, query);
    return result.rows;
  }

  async listResourceWithMeta(name, endpoint, query = {}) {
    const rows = [];
    let from = 0;
    const size = this.config.pageSize || 1000;
    const maxOffset = this.config.maxOffset || 100000;
    const resultWindowLimit = this.config.resultWindowLimit || 10000;
    const pages = [];
    let total;
    let stoppedReason = "unknown";

    while (true) {
      if (from >= resultWindowLimit) {
        stoppedReason = "result_window_limit_reached";
        if (total === undefined || rows.length < total) {
          console.warn(`- WARN ${name} sync stopped at ${rows.length}${total ? ` of ${total}` : ""} rows because JobNimbus result window limit is ${resultWindowLimit}.`);
        }
        break;
      }

      const requestSize = Math.min(size, resultWindowLimit - from);
      const page = await this.getJson(endpoint, { ...query, size: requestSize, from });
      const pageRows = unwrapList(page, name);
      total = typeof page?.count === "number" ? page.count : total;
      pages.push({
        from,
        requestedSize: requestSize,
        received: pageRows.length,
        total
      });
      rows.push(...pageRows);

      if (!pageRows.length) {
        stoppedReason = "empty_page";
        break;
      }
      if (total !== undefined && rows.length >= total) {
        stoppedReason = "total_reached";
        break;
      }
      if (pageRows.length < requestSize) {
        stoppedReason = "short_page";
        break;
      }
      from += pageRows.length;
      if (from >= maxOffset) {
        if (total === undefined || rows.length < total) {
          console.warn(`- WARN ${name} sync stopped at ${rows.length}${total ? ` of ${total}` : ""} rows because local JOBNIMBUS_MAX_OFFSET is ${maxOffset}.`);
        }
        stoppedReason = "max_offset_reached";
        break;
      }
    }

    const complete = (
      stoppedReason === "total_reached"
      || stoppedReason === "short_page"
      || (stoppedReason === "empty_page" && (total === undefined || rows.length >= total))
    );

    return {
      rows,
      meta: {
        name,
        endpoint,
        pageSize: size,
        maxOffset,
        resultWindowLimit,
        query,
        total,
        fetched: rows.length,
        pagesFetched: pages.length,
        complete,
        stoppedReason,
        firstOffset: pages[0]?.from ?? 0,
        lastOffset: pages.at(-1)?.from ?? 0,
        pages
      }
    };
  }
}

export function unwrapList(payload, name) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.[name])) return payload[name];
  if (Array.isArray(payload?.[singular(name)])) return payload[singular(name)];
  if (Array.isArray(payload?.items)) return payload.items;
  return payload ? [payload] : [];
}

function singular(name) {
  if (name === "activities") return "activity";
  if (name === "documents") return "files";
  return name.endsWith("s") ? name.slice(0, -1) : name;
}

function ensureLeadingSlash(value) {
  return value.startsWith("/") ? value : `/${value}`;
}
