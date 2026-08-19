## Diagnosis

`/tmp/opencode` is incidental. I reproduced the failure without it.

On Enter:

1. Pi captures the editor text and immediately clears the editor.
2. Our post-input synchronization sees the empty editor and sets `pendingClipboardPaths = []`.
3. Pi processes the submitted input on the next microtask.
4. The `[Image 1]` marker remains in submitted text, but its path mapping is already gone, so no image or `<file>` part is added.

The failed session confirms this: it contains the extension’s invisible marker sentinel but no image content.

OpenCode avoids this by keeping file parts and marker extmarks in one prompt state, then snapshotting them together before clearing.

## Repair plan

1. **Add the missing submission regression**
   - Paste an image.
   - Type ordinary text, including `/tmp/opencode`.
   - Press Enter through Pi’s deferred idle-submit path.
   - Verify the transformed message contains the image and file tag.

2. **Replace the one-shot path array with a draft attachment registry**
   - Give each attachment a stable opaque ID.
   - Store `ID → path` separately from its visible `[Image N]` label.
   - Embed the ID invisibly in extension-created markers.
   - Manually typed `[Image N]` will have no valid ID and cannot attach anything.

3. **Make submission consume a snapshot**
   - Resolve all complete tracked markers from submitted text before any asynchronous file reads.
   - Keep that snapshot independent of the editor being cleared.
   - Consume registry entries only after `pi.on("input")` has captured them.
   - Handle both deferred idle submission and synchronous streaming/follow-up submission.

4. **Fail closed during restoration**
   - If history, undo, reload, or editor recreation restores a marker without a matching registry entry, treat it as plain text or remove its attachment tracking.
   - Never display a file row or silently reference an old file.

5. **Preserve current UX**
   - Markers remain where pasted.
   - Backspace removes a tracked marker atomically.
   - Sent messages hide image placeholders.
   - File badges remain inline and wrap as needed.

6. **Regression coverage**
   - Immediate image submission.
   - Image followed by `/tmp/opencode`.
   - Multiple images inserted at different positions.
   - Marker deletion.
   - Manually typed markers.
   - Editor recreation/history restoration.
   - Missing temporary image files.
   - Idle, streaming, and follow-up submission paths.

No code was changed during this diagnosis.
