/**
 * The reference images, before they leave the browser.
 *
 * A phone photo is 4–8 MB; four of them are 32 MB of base64, and the
 * request would die on the way. They are scaled down to a size the model
 * can actually use (the image is generated at 1024 px), which makes the
 * request small and the wait short.
 *
 * Nothing is uploaded anywhere: this happens in the browser, on this
 * machine.
 */

export interface PreparedImage {
  dataUrl: string;
  width: number;
  height: number;
  /** true when the file was scaled down */
  resized: boolean;
  /** the original size, in bytes */
  originalBytes: number;
}

const MAX_SIDE = 1600;
const QUALITY = 0.92;

/** Read a file, scale it down if it is too big, and return a data URL. */
export async function prepareImage(file: File): Promise<PreparedImage> {
  const original = await readAsDataUrl(file);
  const size = await imageSize(original);
  if (!size.width || !size.height) {
    // we cannot read it: we send it as it is
    return { dataUrl: original, width: 0, height: 0, resized: false, originalBytes: file.size };
  }
  const longest = Math.max(size.width, size.height);
  if (longest <= MAX_SIDE) {
    return {
      dataUrl: original,
      width: size.width,
      height: size.height,
      resized: false,
      originalBytes: file.size,
    };
  }
  const scale = MAX_SIDE / longest;
  const width = Math.round(size.width * scale);
  const height = Math.round(size.height * scale);
  const scaled = await drawScaled(original, width, height);
  if (!scaled) {
    return {
      dataUrl: original,
      width: size.width,
      height: size.height,
      resized: false,
      originalBytes: file.size,
    };
  }
  return { dataUrl: scaled, width, height, resized: true, originalBytes: file.size };
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('the file cannot be read'));
    reader.readAsDataURL(file);
  });
}

function imageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve({ width: 0, height: 0 });
    image.src = dataUrl;
  });
}

function drawScaled(dataUrl: string, width: number, height: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) {
          resolve(undefined);
          return;
        }
        context.drawImage(image, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', QUALITY));
      } catch {
        resolve(undefined);
      }
    };
    image.onerror = () => resolve(undefined);
    image.src = dataUrl;
  });
}
