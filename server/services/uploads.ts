/**
 * Every uploaded photo goes through here:
 *  - iPhone HEIC/HEIF -> JPEG (browsers, marketplaces and our image tools can't read HEIC)
 *  - auto-rotate (phones store "rotate me" in EXIF; many sites ignore it -> sideways photos)
 *  - downsize to 2400px on the long edge (eBay-friendly, saves space, faster AI)
 *  - strip metadata, including GPS location (phone photos often reveal where you live)
 */
import type { Request, Response, NextFunction } from "express";
import convert from "heic-convert";
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";

const HEIF_BRANDS = ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"];

export function isHeic(buf: Buffer) {
  if (buf.length < 12 || buf.toString("ascii", 4, 8) !== "ftyp") return false;
  const brand = buf.toString("ascii", 8, 12);
  // AVIF also uses "mif1"; only treat it as HEIC when the major brand isn't avif.
  return HEIF_BRANDS.includes(brand) && brand !== "avif";
}

export const MAX_EDGE = 2400;

/** Normalize one image file in place (may change the extension to .jpg). Returns the final path. */
export async function normalizeImage(file: string): Promise<string> {
  let buf: Buffer = fs.readFileSync(file);
  if (isHeic(buf)) buf = Buffer.from(await convert({ buffer: buf, format: "JPEG", quality: 0.92 }));
  const out = file.replace(/\.[a-z0-9]+$/i, "") + ".jpg";
  const pipeline = sharp(buf, { failOn: "none" })
    .rotate() // apply EXIF orientation, then drop it
    .resize(MAX_EDGE, MAX_EDGE, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" }); // transparent PNGs -> white, not black
  // sharp drops all metadata (EXIF/GPS/XMP) unless .withMetadata() is called.
  await pipeline.jpeg({ quality: 88, mozjpeg: true }).toFile(out + ".tmp");
  fs.renameSync(out + ".tmp", out);
  if (out !== file) fs.rmSync(file, { force: true });
  return out;
}

export const IMAGE_EXT = /\.(jpe?g|png|webp|gif|heic|heif|avif|tiff?)$/i;

export function isImageUpload(file: { mimetype: string; originalname: string }) {
  return /^image\//.test(file.mimetype) || IMAGE_EXT.test(file.originalname);
}

/** Express middleware: run after multer; normalizes req.file / req.files in place. Bad files are dropped with a note. */
export async function normalizeUploads(req: Request, _res: Response, next: NextFunction) {
  try {
    const one = req.file as Express.Multer.File | undefined;
    const many = (Array.isArray(req.files) ? req.files : []) as Express.Multer.File[];
    const skipped: string[] = [];
    const fix = async (f: Express.Multer.File) => {
      try {
        f.path = await normalizeImage(f.path);
        f.filename = path.basename(f.path);
        f.mimetype = "image/jpeg";
        return true;
      } catch {
        fs.rmSync(f.path, { force: true });
        skipped.push(f.originalname);
        return false;
      }
    };
    if (one && !(await fix(one))) req.file = undefined;
    if (many.length) {
      const ok: Express.Multer.File[] = [];
      for (const f of many) if (await fix(f)) ok.push(f);
      req.files = ok;
    }
    (req as Request & { skippedUploads?: string[] }).skippedUploads = skipped;
    next();
  } catch (e) {
    next(e);
  }
}
