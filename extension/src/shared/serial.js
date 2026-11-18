// One-at-a-time execution for async work. Tasks run in the order they were queued; a
// failing task rejects its own promise but never blocks the ones after it.
//
// Do not queue a task from inside another task of the same queue and await it: that
// waits for itself. Callers that are already inside the queue call the inner function.

export function createSerialQueue() {
  let tail = Promise.resolve();
  let pending = 0;
  const run = (fn) => {
    pending++;
    const result = tail.then(() => fn());
    tail = result.then(
      () => {
        pending--;
      },
      () => {
        pending--;
      },
    );
    return result;
  };
  Object.defineProperty(run, 'pending', { get: () => pending });
  return run;
}
