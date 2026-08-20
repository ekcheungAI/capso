import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("annotation delivery and close actions share one session-scoped owner lease", async () => {
  const view = await readFile(new URL("./AnnotationEditor.tsx", import.meta.url), "utf8");

  assert.match(view, /const annotationActionInFlight = useRef<string \| null>\(null\)/);
  assert.match(view, /function beginAnnotationAction\(key: string\) \{[\s\S]*?if \(annotationActionInFlight\.current !== null\) return false;[\s\S]*?annotationActionInFlight\.current = key/);
  assert.match(view, /function endAnnotationAction\(key: string\) \{[\s\S]*?if \(annotationActionInFlight\.current !== key\) return;[\s\S]*?annotationActionInFlight\.current = null/);

  assert.match(view, /listen<AnnotationDragEnded>\("annotation-drag-ended"[\s\S]*?endAnnotationAction\(`drag:\$\{capture\.sessionId\}`\)/);
  assert.match(view, /const cancel = useCallback\(async \(\) => \{[\s\S]*?const actionKey = `cancel:\$\{capture\.sessionId\}`;[\s\S]*?!beginAnnotationAction\(actionKey\)[\s\S]*?finally \{\s*endAnnotationAction\(actionKey\)/);
  assert.match(view, /startAnnotationDrag[\s\S]*?const actionKey = `drag:\$\{capture\.sessionId\}`;[\s\S]*?!beginAnnotationAction\(actionKey\)/);
  assert.match(view, /exportAnnotation[\s\S]*?const actionKey = `export:\$\{capture\.sessionId\}`;[\s\S]*?!beginAnnotationAction\(actionKey\)[\s\S]*?finally \{\s*endAnnotationAction\(actionKey\)/);
  assert.match(view, /copyAnnotation[\s\S]*?const actionKey = `copy:\$\{capture\.sessionId\}`;[\s\S]*?!beginAnnotationAction\(actionKey\)[\s\S]*?finally \{\s*endAnnotationAction\(actionKey\)/);
  assert.match(view, /async function save\(\) \{[\s\S]*?const actionKey = `save:\$\{capture\.sessionId\}`;[\s\S]*?!beginAnnotationAction\(actionKey\)[\s\S]*?finally \{[\s\S]*?endAnnotationAction\(actionKey\)/);
  assert.match(view, /let receivedCaptureEvent = false;[\s\S]*?receivedCaptureEvent = true;[\s\S]*?if \(!disposed && current && !receivedCaptureEvent\) setCapture\(current\)/);
});
