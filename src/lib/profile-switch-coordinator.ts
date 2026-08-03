export class LatestProfileSwitchCoordinator {
  private latestRequestId = 0;

  private commitQueue: Promise<void> = Promise.resolve();

  begin() {
    this.latestRequestId += 1;
    return this.latestRequestId;
  }

  async commitIfLatest(requestId: number, commit: () => Promise<void> | void) {
    let committed = false;
    const operation = this.commitQueue.then(async () => {
      if (requestId !== this.latestRequestId) return;
      await commit();
      committed = true;
    });

    this.commitQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
    return committed;
  }
}
