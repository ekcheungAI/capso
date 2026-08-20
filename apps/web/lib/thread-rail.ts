export type ThreadRailPresentation = {
  heading: string;
  ariaLabel: string;
};

const count = (value: number) =>
  Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/**
 * Keeps the rail's visible count distinct from the complete project total.
 * Citations may include captures outside the project, so that state names the
 * latest answer instead of implying that it describes project membership.
 */
export function threadRailPresentation(
  totalProjectCaptures: number,
  latestAnswerCitations: number,
): ThreadRailPresentation {
  const total = count(totalProjectCaptures);
  const citations = count(latestAnswerCitations);

  if (citations > 0) {
    const noun = citations === 1 ? "source" : "sources";
    return {
      heading: `Latest answer ${noun} · ${citations}`,
      ariaLabel: `${citations} ${noun} cited by the latest answer`,
    };
  }

  const visible = Math.min(total, 2);
  if (total > visible) {
    return {
      heading: `Project preview · ${visible} of ${total}`,
      ariaLabel: `Showing ${visible} of ${total} captures in this project`,
    };
  }

  return {
    heading: `In this project · ${total}`,
    ariaLabel:
      total === 0
        ? "No captures in this project"
        : total === 1
          ? "The capture in this project"
          : `All ${total} captures in this project`,
  };
}
