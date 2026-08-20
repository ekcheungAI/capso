export type LatestRequestGate = {
  begin: () => () => boolean;
  invalidate: () => void;
};

export function createLatestRequestGate(): LatestRequestGate {
  let generation = 0;
  return {
    begin() {
      const requestGeneration = ++generation;
      return () => requestGeneration === generation;
    },
    invalidate() {
      generation += 1;
    },
  };
}
