export class CaptureCoordinator {
  #active = false;

  async run(task) {
    if (this.#active) {
      return { ok: false, message: "Another capture is already in progress." };
    }
    this.#active = true;
    try {
      return await task();
    } finally {
      this.#active = false;
    }
  }
}
