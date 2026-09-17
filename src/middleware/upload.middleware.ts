import multer from "multer";
import path from "path";
import { UPLOADS_DIR } from "../config/constants.js";

// Multer disk storage for handling real file uploads from frontend
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    const base = path
      .basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9_-]/g, "");
    cb(null, `${base || "image"}-${Date.now()}${ext}`);
  },
});

export const upload = multer({ storage });
