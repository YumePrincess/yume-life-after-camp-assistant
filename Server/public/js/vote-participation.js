(() => {
  "use strict";

  function create({ getContext, request, apply, onError, maxAgeMs = 30_000, now = Date.now }) {
    let cached = null;
    let inFlight = null;
    let queued = false;

    function sameContext(left, right) {
      return Boolean(left && right && left.identityCode === right.identityCode &&
        left.password === right.password && left.scopeKey === right.scopeKey &&
        left.revision === right.revision);
    }

    async function drain(operation) {
      let applied = false;
      do {
        queued = false;
        const context = getContext();
        if (!context) {
          cached = null;
          return false;
        }
        operation.context = context;
        try {
          const result = await request(context);
          // Bootstrap, login or a successful submission may change the context
          // while a read is pending. Discard that read and query the latest one.
          if (!sameContext(context, getContext())) {
            queued = Boolean(getContext());
            continue;
          }
          apply(result, context);
          cached = { context, checkedAt: now() };
          applied = true;
        } catch (error) {
          if (!sameContext(context, getContext())) {
            queued = Boolean(getContext());
            continue;
          }
          cached = null;
          onError?.(error);
          applied = false;
        }
      } while (queued);
      return applied;
    }

    function refresh({ force = false } = {}) {
      const context = getContext();
      if (!context) {
        cached = null;
        return Promise.resolve(false);
      }
      if (inFlight) {
        if (force || !sameContext(context, inFlight.context)) queued = true;
        return inFlight.promise;
      }
      if (!force && sameContext(context, cached?.context) && now() - cached.checkedAt < maxAgeMs) {
        return Promise.resolve(true);
      }
      const operation = { context, promise: null };
      inFlight = operation;
      operation.promise = drain(operation).finally(() => {
        if (inFlight === operation) inFlight = null;
      });
      return operation.promise;
    }

    return Object.freeze({ refresh });
  }

  window.MrzhVoteParticipation = Object.freeze({ create });
})();
