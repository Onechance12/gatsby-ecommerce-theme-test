const KEY_PATTERN = /^[A-Za-z0-9._~-]{1,255}$/;

/**
 * A bounded in-memory per-principal transaction queue. Operations for one key
 * run in exact arrival order while unrelated principals remain independent.
 */
export function createKeyedOperationQueue({
  maxKeys = 512
} = {}) {
  if (
    !Number.isSafeInteger(maxKeys)
    || maxKeys < 1
    || maxKeys > 10_000
  ) {
    throw new TypeError(
      "maxKeys must be an integer between 1 and 10000"
    );
  }
  const tails = new Map();

  async function run(key, operation) {
    if (
      typeof key !== "string"
      || !KEY_PATTERN.test(key)
    ) {
      throw new TypeError("queue key is invalid");
    }
    if (typeof operation !== "function") {
      throw new TypeError("operation must be a function");
    }
    if (!tails.has(key) && tails.size >= maxKeys) {
      throw new KeyedOperationQueueError();
    }

    const previous = tails.get(key) || Promise.resolve();
    let release;
    const reservation = new Promise((resolve) => {
      release = resolve;
    });
    const tail = previous
      .catch(() => undefined)
      .then(() => reservation);
    tails.set(key, tail);

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  }

  return Object.freeze({ run });
}

export class KeyedOperationQueueError extends Error {
  constructor() {
    super("Connector operation capacity is temporarily unavailable.");
    this.name = "KeyedOperationQueueError";
    this.code = "connector_operation_capacity";
    this.statusCode = 503;
  }
}
