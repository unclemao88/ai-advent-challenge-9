/**
 * Runs async tasks strictly one after another.
 *
 * This is the mutex behind every read-modify-write in the app: two requests
 * finishing at the same moment update a memory layer in sequence instead of
 * racing, so neither can overwrite the other's change. A failing task rejects
 * its own caller but never blocks the tasks queued behind it.
 */
export class SerialQueue {
  #tail = Promise.resolve();

  /**
   * @template T
   * @param {() => Promise<T> | T} task
   * @returns {Promise<T>}
   */
  run(task) {
    const result = this.#tail.then(() => task());
    this.#tail = result.catch(() => {});
    return result;
  }
}
