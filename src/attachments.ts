type AttachmentAnchors = [number, number, number, number, number, number];
declare const petAttachmentFrames: Record<string, AttachmentAnchors[][]>;

const attachmentPet = document.querySelector<HTMLElement>('#pet')!;
const attachmentSprite = document.querySelector<HTMLElement>('#pet .sprite')!;
const wornAccessory = document.querySelector<HTMLElement>('#accessory')!;
const wornClip = document.querySelector<HTMLElement>('#clip')!;
const accessoryOffsets: Record<string, [number, number]> = {
  crown: [-21, -19], halo: [-21, -18], ribbon: [-12, -6], star: [20, -12],
};
let attachmentAnimationFrame: number | undefined;

function positionAttachment(element: HTMLElement, x: number, y: number) {
  const left = x + 'px', top = y + 'px';
  if (element.style.left !== left) element.style.left = left;
  if (element.style.top !== top) element.style.top = top;
}

function syncAccessoryPositions() {
  attachmentAnimationFrame = undefined;
  const accessory = attachmentPet.dataset.accessory ?? 'none';
  if (attachmentPet.hidden || document.hidden || (accessory === 'none' && wornClip.hidden)) return;
  // Read the sprite's actual frame so CSS pauses, blink timing, and reduced motion stay in sync.
  const spriteStyle = getComputedStyle(attachmentSprite);
  const frame = Math.round(Math.abs(parseFloat(spriteStyle.backgroundPositionX)) / 128) % 6;
  const row = Math.round(Math.abs(parseFloat(spriteStyle.backgroundPositionY)) / 128);
  const anchors = petAttachmentFrames[attachmentPet.dataset.kind ?? '']?.[row]?.[frame];
  if (anchors) {
    const [headX, headY, chestX, chestY, clipX, clipY] = anchors;
    const offset = accessoryOffsets[accessory];
    if (offset) {
      const headwear = accessory === 'crown' || accessory === 'halo';
      positionAttachment(wornAccessory, (headwear ? headX : chestX) * 4 + offset[0], (headwear ? headY : chestY) * 4 + offset[1]);
      wornAccessory.style.visibility = 'visible';
    }
    if (!wornClip.hidden) positionAttachment(wornClip, clipX * 4, clipY * 4);
  }
  attachmentAnimationFrame = requestAnimationFrame(syncAccessoryPositions);
}

function queueAccessorySync() {
  if (attachmentAnimationFrame === undefined) attachmentAnimationFrame = requestAnimationFrame(syncAccessoryPositions);
}
new MutationObserver(queueAccessorySync).observe(attachmentPet, {
  attributes: true, subtree: true, attributeFilter: ['data-accessory', 'data-kind', 'data-mood', 'hidden'],
});
document.addEventListener('visibilitychange', queueAccessorySync);
queueAccessorySync();
