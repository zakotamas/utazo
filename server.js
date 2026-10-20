const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === "production";

if (IS_PRODUCTION && !process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be configured in production.");
}

const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const UPLOAD_DIR = path.join(ROOT, "uploads");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "ping.sqlite"));

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    latitude REAL,
    longitude REAL,
    image TEXT,
    location_updated_at TEXT,
    public_location INTEGER NOT NULL DEFAULT 0
  );
`);

const insertUser = db.prepare(`
  INSERT INTO users (username, email, password_hash)
  VALUES (?, ?, ?)
`);

const findUserByEmail = db.prepare(`
  SELECT * FROM users WHERE email = ?
`);

const findUserByUsername = db.prepare(`
  SELECT id FROM users WHERE username = ?
`);

const findUserById = db.prepare(`
  SELECT * FROM users WHERE id = ?
`);

const countPins = db.prepare(`
  SELECT COUNT(*) AS count
  FROM users
  WHERE public_location = 1
    AND latitude IS NOT NULL
    AND longitude IS NOT NULL
    AND image IS NOT NULL
`);

const getPins = db.prepare(`
  SELECT
    id,
    username,
    latitude,
    longitude,
    image,
    timezone,
    location_updated_at
  FROM users
  WHERE public_location = 1
    AND latitude IS NOT NULL
    AND longitude IS NOT NULL
    AND image IS NOT NULL
  ORDER BY location_updated_at DESC
  LIMIT 5000
`);

const updateProfile = db.prepare(`
  UPDATE users
  SET latitude = ?,
      longitude = ?,
      image = ?,
      timezone = ?,
      location_updated_at = ?,
      public_location = 1
  WHERE id = ?
`);

const clearPublicLocation = db.prepare(`
  UPDATE users
  SET public_location = 0
  WHERE id = ?
`);

const deleteUser = db.prepare(`
  DELETE FROM users WHERE id = ?
`);

app.disable("x-powered-by");

if (IS_PRODUCTION) {
  // Csak akkor állítsd be, ha az alkalmazás valóban
  // megbízható reverse proxy mögött fut.
  app.set("trust proxy", 1);
}

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "https://unpkg.com"
        ],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://unpkg.com",
          "https://fonts.googleapis.com"
        ],
        fontSrc: [
          "'self'",
          "https://fonts.gstatic.com",
          "data:"
        ],
        imgSrc: [
          "'self'",
          "data:",
          "blob:",
          "https://*.tile.openstreetmap.org"
        ],
        connectSrc: ["'self"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: IS_PRODUCTION ? [] : null
      }
    }
  })
);

app.use(express.json({ limit: "20kb" }));

app.use(
  session({
    name: "ping.sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: new SQLiteStore({
      db: "sessions.sqlite",
      dir: DATA_DIR
    }),
    cookie: {
      httpOnly: true,
      secure: IS_PRODUCTION,
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000
    }
  })
);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error: "Túl sok próbálkozás. Kérjük, próbáld meg később."
  }
});

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,

    filename: (req, file, callback) => {
      const extensionMap = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp"
      };

      const extension = extensionMap[file.mimetype];

      if (!extension) {
        return callback(new Error("INVALID_IMAGE_TYPE"));
      }

      callback(
        null,
        crypto.randomBytes(24).toString("hex") + extension
      );
    }
  }),

  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 1
  },

  fileFilter: (req, file, callback) => {
    const allowed = [
      "image/jpeg",
      "image/png",
      "image/webp"
    ];

    if (!allowed.includes(file.mimetype)) {
      return callback(new Error("INVALID_IMAGE_TYPE"));
    }

    callback(null, true);
  }
});

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({
      error: "A folytatáshoz jelentkezz be."
    });
  }

  next();
}

function validCoordinates(latitude, longitude) {
  return (
    typeof latitude === "number" &&
    typeof longitude === "number" &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

function validTimezone(timezone) {
  if (typeof timezone !== "string" || timezone.length > 100) {
    return false;
  }

  try {
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone
    });

    return true;
  } catch {
    return false;
  }
}

function publicUser(user) {
  if (!user) return null;

  return {
    id: user.id,
    username: user.username,
    email: user.email,
    timezone: user.timezone,
    hasLocation: Boolean(
      user.public_location &&
      user.latitude !== null &&
      user.longitude !== null &&
      user.image
    ),
    image: user.public_location ? user.image : null
  };
}

function removeOldImage(imagePath) {
  if (!imagePath) return;

  const filename = path.basename(imagePath);
  const fullPath = path.join(UPLOAD_DIR, filename);

  fs.unlink(fullPath, () => {});
}

app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

// Felhasználó regisztrációja.
app.post(
  "/api/register",
  authLimiter,
  async (req, res, next) => {
    try {
      const { username, email, password } = req.body || {};

      if (
        typeof username !== "string" ||
        !/^[a-zA-Z0-9_-]{3,24}$/.test(username)
      ) {
        return res.status(400).json({
          error:
            "A felhasználónév 3–24 karakteres lehet, betűkkel, számokkal, kötőjellel és aláhúzással."
        });
      }

      if (
        typeof email !== "string" ||
        email.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      ) {
        return res.status(400).json({
          error: "Adj meg egy érvényes e-mail-címet."
        });
      }

      if (
        typeof password !== "string" ||
        password.length < 12 ||
        password.length > 128
      ) {
        return res.status(400).json({
          error: "A jelszó legalább 12 karakteres legyen."
        });
      }

      const normalizedEmail = email.trim().toLowerCase();
      const normalizedUsername = username.trim();

      if (
        findUserByEmail.get(normalizedEmail) ||
        findUserByUsername.get(normalizedUsername)
      ) {
        return res.status(409).json({
          error: "Ez a felhasználónév vagy e-mail-cím már foglalt."
        });
      }

      const passwordHash = await bcrypt.hash(password, 12);

      let result;

      try {
        result = insertUser.run(
          normalizedUsername,
          normalizedEmail,
          passwordHash
        );
      } catch (error) {
        if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
          return res.status(409).json({
            error: "Ez a felhasználónév vagy e-mail-cím már foglalt."
          });
        }

        throw error;
      }

      await new Promise((resolve, reject) => {
        req.session.regenerate(error => {
          if (error) return reject(error);
          resolve();
        });
      });

      req.session.userId = result.lastInsertRowid;

      res.status(201).json({
        user: publicUser(findUserById.get(result.lastInsertRowid))
      });
    } catch (error) {
      next(error);
    }
  }
);

// Bejelentkezés.
app.post(
  "/api/login",
  authLimiter,
  async (req, res, next) => {
    try {
      const { email, password } = req.body || {};

      if (
        typeof email !== "string" ||
        typeof password !== "string" ||
        email.length > 254 ||
        password.length > 128
      ) {
        return res.status(400).json({
          error: "Hibás e-mail-cím vagy jelszó."
        });
      }

      const user = findUserByEmail.get(
        email.trim().toLowerCase()
      );

      const passwordMatches = await bcrypt.compare(
        password,
        user?.password_hash ||
          "$2a$12$abcdefghijklmnopqrstuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu"
      );

      if (!user || !passwordMatches) {
        return res.status(401).json({
          error: "Hibás e-mail-cím vagy jelszó."
        });
      }

      await new Promise((resolve, reject) => {
        req.session.regenerate(error => {
          if (error) return reject(error);
          resolve();
        });
      });

      req.session.userId = user.id;

      res.json({
        user: publicUser(user)
      });
    } catch (error) {
      next(error);
    }
  }
);

// Aktuális felhasználó.
app.get("/api/me", (req, res) => {
  if (!req.session.userId) {
    return res.json({ user: null });
  }

  const user = findUserById.get(req.session.userId);

  if (!user) {
    return res.json({ user: null });
  }

  res.json({
    user: publicUser(user)
  });
});

// Nyilvános pingek.
app.get("/api/pins", (req, res) => {
  const pins = getPins.all().map(pin => ({
    id: pin.id,
    username: pin.username,
    latitude: pin.latitude,
    longitude: pin.longitude,
    image: pin.image,
    timezone: pin.timezone,
    locationUpdatedAt: pin.location_updated_at
  }));

  res.json({
    count: countPins.get().count,
    pins
  });
});

// Profil és ping létrehozása vagy frissítése.
app.post(
  "/api/profile",
  requireAuth,
  (req, res, next) => {
    upload.single("image")(req, res, error => {
      if (error) {
        const status =
          error.code === "LIMIT_FILE_SIZE" ? 413 : 400;

        return res.status(status).json({
          error:
            error.message === "INVALID_IMAGE_TYPE"
              ? "Csak JPEG, PNG vagy WebP képet tölthetsz fel."
              : error.code === "LIMIT_FILE_SIZE"
              ? "A kép legfeljebb 5 MB lehet."
              : "A feltöltés nem sikerült."
        });
      }

      next();
    });
  },
  (req, res, next) => {
    try {
      const latitude = Number(req.body.latitude);
      const longitude = Number(req.body.longitude);

      const timezone =
        typeof req.body.timezone === "string"
          ? req.body.timezone
          : "UTC";

      const consent = req.body.consent === "true";

      if (!consent) {
        if (req.file) {
          removeOldImage(req.file.filename);
        }

        return res.status(400).json({
          error:
            "A nyilvános térképes megjelenítéshez kifejezett hozzájárulás szükséges."
        });
      }

      if (!validCoordinates(latitude, longitude)) {
        if (req.file) {
          removeOldImage(req.file.filename);
        }

        return res.status(400).json({
          error: "Érvénytelen földrajzi koordináták."
        });
      }

      if (!validTimezone(timezone)) {
        if (req.file) {
          removeOldImage(req.file.filename);
        }

        return res.status(400).json({
          error: "Érvénytelen időzóna."
        });
      }

      const currentUser = findUserById.get(req.session.userId);

      if (!currentUser) {
        if (req.file) {
          removeOldImage(req.file.filename);
        }

        return res.status(401).json({
          error: "A felhasználó már nem érhető el."
        });
      }

      if (!req.file && !currentUser.image) {
        return res.status(400).json({
          error: "A ping létrehozásához tölts fel egy képet."
        });
      }

      const image = req.file
        ? "/uploads/" + req.file.filename
        : currentUser.image;

      const updatedAt = new Date().toISOString();

      updateProfile.run(
        latitude,
        longitude,
        image,
        timezone,
        updatedAt,
        req.session.userId
      );

      if (req.file && currentUser.image) {
        removeOldImage(currentUser.image);
      }

      res.json({
        success: true,
        user: publicUser(
          findUserById.get(req.session.userId)
        )
      });
    } catch (error) {
      next(error);
    }
  }
);

// Saját ping elrejtése.
app.post("/api/profile/hide", requireAuth, (req, res) => {
  clearPublicLocation.run(req.session.userId);

  res.json({ success: true });
});

// Fiók törlése.
app.delete("/api/account", requireAuth, async (req, res, next) => {
  try {
    const user = findUserById.get(req.session.userId);

    if (!user) {
      return res.status(404).json({
        error: "A fiók nem található."
      });
    }

    deleteUser.run(user.id);

    removeOldImage(user.image);

    await new Promise((resolve, reject) => {
      req.session.destroy(error => {
        if (error) return reject(error);
        resolve();
      });
    });

    res.clearCookie("ping.sid");

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// Kijelentkezés.
app.post("/api/logout", (req, res, next) => {
  req.session.destroy(error => {
    if (error) return next(error);

    res.clearCookie("ping.sid");

    res.json({ success: true });
  });
});

// A feltöltött képek kiszolgálása.
app.use(
  "/uploads",
  express.static(UPLOAD_DIR, {
    dotfiles: "deny",
    index: false,
    maxAge: IS_PRODUCTION ? "1d" : 0
  })
);

app.use(express.static(PUBLIC_DIR));

app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// Hibakezelés.
app.use((err, req, res, next) => {
  console.error(err);

  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({
    error: "Váratlan hiba történt. Kérjük, próbáld meg újra."
  });
});

app.listen(PORT, () => {
  console.log(`PING! elindult: http://localhost:${PORT}`);
});