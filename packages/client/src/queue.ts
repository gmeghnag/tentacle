/**
 * A minimal single-consumer async queue: `push` values, `close` to end the
 * iteration, `fail` to end it with an error. Backs `RemoteSession.send`, turning
 * the push-based `session/update` stream into the pull-based async iterator the
 * TUI consumes.
 */
export class AsyncQueue<T> {
  private readonly items: T[] = [];
  private waiter: ((result: IteratorResult<T>) => void) | null = null;
  private closed = false;
  private failure: unknown = null;

  push(item: T): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.wake();
  }

  fail(error: unknown): void {
    if (this.closed) {
      return;
    }
    this.failure = error;
    this.closed = true;
    this.wake();
  }

  /** Remove and return the items not consumed yet (e.g. of a queue never iterated). */
  takeBuffered(): T[] {
    return this.items.splice(0);
  }

  private wake(): void {
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter({ value: undefined as never, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      if (this.items.length > 0) {
        yield this.items.shift() as T;
        continue;
      }
      if (this.closed) {
        if (this.failure !== null) {
          throw this.failure;
        }
        return;
      }
      const result = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiter = resolve;
      });
      if (result.done) {
        if (this.failure !== null) {
          throw this.failure;
        }
        return;
      }
      yield result.value;
    }
  }
}
