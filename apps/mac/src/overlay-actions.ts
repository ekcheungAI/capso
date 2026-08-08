export type OverlayActionKind = "annotate" | "copy" | "save" | "drag" | "dismiss";

export type OverlayActionToken = Readonly<{
  actionGeneration: number;
  captureGeneration: number;
  kind: OverlayActionKind;
  path: string;
}>;

/**
 * Orders async UI responses against capture replacement. Native commands do
 * their own exact-current validation; this controller prevents an old promise
 * continuation from changing the presentation or controls of a newer capture.
 */
export class OverlayActionCoordinator {
  private actionGeneration = 0;
  private active: OverlayActionToken | null = null;
  private captureGeneration = 0;
  private currentPath: string | null;

  constructor(initialPath: string | null = null) {
    this.currentPath = initialPath;
  }

  activateCapture(path: string) {
    this.captureGeneration += 1;
    this.currentPath = path;
    this.active = null;
    return this.captureGeneration;
  }

  begin(path: string, kind: OverlayActionKind): OverlayActionToken | null {
    if (this.active !== null || this.currentPath !== path) return null;
    this.actionGeneration += 1;
    const token = {
      actionGeneration: this.actionGeneration,
      captureGeneration: this.captureGeneration,
      kind,
      path,
    } as const;
    this.active = token;
    return token;
  }

  isCurrent(token: OverlayActionToken) {
    return (
      this.currentPath === token.path &&
      this.captureGeneration === token.captureGeneration &&
      this.active?.actionGeneration === token.actionGeneration
    );
  }

  finish(token: OverlayActionToken) {
    if (!this.isCurrent(token)) return false;
    this.active = null;
    return true;
  }

  dismiss(token: OverlayActionToken) {
    if (!this.isCurrent(token)) return false;
    this.currentPath = null;
    this.active = null;
    return true;
  }

  generation() {
    return this.captureGeneration;
  }
}
