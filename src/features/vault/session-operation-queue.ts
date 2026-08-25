export class SessionOperationQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<Result>(
    sessionId: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(sessionId, tail);
    void tail.then(() => {
      if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId);
    });
    return result;
  }
}
