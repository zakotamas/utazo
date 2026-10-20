"use strict";

const $ = selector => document.querySelector(selector);

const state = {
  map: null,
  markers: null,
  user: null,
  pins: [],
  authMode: "register",
  toastTimer: null,
  refreshTimer: null,
  imagePreviewUrl: null
};


// --------------------------------------------------
// SEGÉDFÜGGVÉNYEK
// --------------------------------------------------

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...(options.headers || {})
    }
  });

  let data = {};

  try {
    data = await response.json();
  } catch {
    data = {};
  }

  if (!response.ok) {
    throw new Error(
      data.error || "Valami hiba történt."
    );
  }

  return data;
}


function showToast(message) {
  const toast = $("#toast");

  toast.textContent = message;
  toast.classList.add("visible");

  clearTimeout(state.toastTimer);

  state.toastTimer = setTimeout(() => {
    toast.classList.remove("visible");
  }, 3200);
}


function setError(selector, message = "") {
  $(selector).textContent = message;
}


function setBusy(button, busy, busyText = "Folyamatban...") {
  if (!button.dataset.originalText) {
    button.dataset.originalText = button.textContent;
  }

  button.disabled = busy;

  button.textContent = busy
    ? busyText
    : button.dataset.originalText;
}


function openModal(id) {
  const modal = document.getElementById(id);

  modal.classList.remove("hidden");

  document.body.classList.add("modal-open");

  const firstInput = modal.querySelector(
    "input:not([type='checkbox']):not([type='file'])"
  );

  if (firstInput) {
    setTimeout(() => firstInput.focus(), 100);
  }
}


function closeModal(modal) {
  modal.classList.add("hidden");

  if (!document.querySelector(".modal-backdrop:not(.hidden)")) {
    document.body.classList.remove("modal-open");
  }
}


function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };

    return entities[character];
  });
}


function validCoordinates(lat, lng) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}


// --------------------------------------------------
// DÁTUM ÉS IDŐ
// --------------------------------------------------

function updateDateTime() {
  const now = new Date();

  const dateElement = $("#current-date");

  const formattedDate = new Intl.DateTimeFormat(
    navigator.language || "hu-HU",
    {
      year: "numeric",
      month: "short",
      day: "numeric",
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
    }
  ).format(now);

  dateElement.textContent = formattedDate;

  $("#footer-year").textContent = now.getFullYear();
}


function formatPinDate(isoDate, timezone) {
  if (!isoDate) {
    return "Időpont nem érhető el";
  }

  try {
    const date = new Date(isoDate);

    if (Number.isNaN(date.getTime())) {
      return "Időpont nem érhető el";
    }

    return new Intl.DateTimeFormat("hu-HU", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: timezone || "UTC",
      timeZoneName: "short"
    }).format(date);

  } catch {
    return "Időpont nem érhető el";
  }
}


// --------------------------------------------------
// TÉRKÉP
// --------------------------------------------------

function initMap() {
  if (typeof L === "undefined") {
    $("#map-loading").textContent =
      "A térkép nem tölthető be. Ellenőrizd az internetkapcsolatot.";

    return;
  }

  state.map = L.map("map", {
    center: [25, 10],
    zoom: 2,
    minZoom: 2,
    maxZoom: 18,
    zoomControl: false,
    worldCopyJump: true
  });

  L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
      minZoom: 2,
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors'
    }
  ).addTo(state.map);

  L.control.zoom({
    position: "bottomright"
  }).addTo(state.map);

  state.markers = L.markerClusterGroup({
    showCoverageOnHover: false,
    spiderfyOnMaxZoom: true,
    zoomToBoundsOnClick: true,
    maxClusterRadius: 45,
    disableClusteringAtZoom: 16,
    chunkedLoading: true
  });

  state.map.addLayer(state.markers);

  state.map.on("click", event => {
    // A térképre kattintva ne nyissunk automatikusan
    // profilt vagy módosítsunk helyzetet.
    console.debug(
      "Map clicked:",
      event.latlng.lat,
      event.latlng.lng
    );
  });

  setTimeout(() => {
    state.map.invalidateSize();
  }, 100);
}


function createPinIcon() {
  return L.divIcon({
    className: "ping-marker",
    html: '<div class="custom-pin"></div>',
    iconSize: [35, 43],
    iconAnchor: [17, 40],
    popupAnchor: [0, -38]
  });
}


function createPopup(pin) {
  const username = escapeHtml(pin.username);

  const imageUrl = safeImageUrl(pin.image);

  const date = formatPinDate(
    pin.locationUpdatedAt,
    pin.timezone
  );

  return `
    <div class="ping-popup">

      <img
        src="${escapeHtml(imageUrl)}"
        alt="${username} képe"
        loading="lazy"
        referrerpolicy="no-referrer"
      >

      <div class="ping-popup-content">

        <div class="ping-popup-name">
          @${username}
        </div>

        <div class="ping-popup-meta">
          <span>✳ Pingelt hely</span><br>
          <span>${escapeHtml(date)}</span>
        </div>

      </div>

    </div>
  `;
}



function safeImageUrl(url) {
  if (typeof url !== "string" || !url.trim()) {
    return "";
  }

  // Helyben feltöltött képek (localStorage / FileReader).
  if (/^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(url)) {
    return url;
  }

  // HTTPS-en tárolt képek, például az Unsplash mintaképei.
  try {
    const parsedUrl = new URL(url, window.location.href);

    if (
      parsedUrl.protocol === "https:" &&
      (
        parsedUrl.hostname === "images.unsplash.com" ||
        parsedUrl.hostname === "plus.unsplash.com"
      )
    ) {
      return parsedUrl.href;
    }

    // A régi szerveres feltöltési útvonalak megtartása.
    if (
      parsedUrl.origin === window.location.origin &&
      /^\/uploads\/[a-f0-9]{48}\.(jpg|png|webp)$/i.test(parsedUrl.pathname)
    ) {
      return parsedUrl.href;
    }
  } catch (error) {
    console.warn("Érvénytelen kép-URL:", error);
  }

  return "";
}






// --------------------------------------------------
// HELYI DEMÓ PINGEK
// --------------------------------------------------

function getDemoPins() {
  const now = Date.now();

  return [
    {
      id: 1,
      username: "amelie",
      latitude: 48.2082,
      longitude: 16.3738,
      image: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=400",
      timezone: "Europe/Vienna",
      locationUpdatedAt: new Date(now - 5 * 60000).toISOString()
    },
    {
      id: 2,
      username: "noah",
      latitude: 40.7128,
      longitude: -74.0060,
      image: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=400",
      timezone: "America/New_York",
      locationUpdatedAt: new Date(now - 18 * 60000).toISOString()
    },
    {
      id: 3,
      username: "luna",
      latitude: 35.6762,
      longitude: 139.6503,
      image: "https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=400",
      timezone: "Asia/Tokyo",
      locationUpdatedAt: new Date(now - 32 * 60000).toISOString()
    },
    {
      id: 4,
      username: "leo",
      latitude: -33.8688,
      longitude: 151.2093,
      image: "https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=400",
      timezone: "Australia/Sydney",
      locationUpdatedAt: new Date(now - 47 * 60000).toISOString()
    },
    {
      id: 5,
      username: "maya",
      latitude: -23.5505,
      longitude: -46.6333,
      image: "https://images.unsplash.com/photo-1531123897727-8f129e1688ce?w=400",
      timezone: "America/Sao_Paulo",
      locationUpdatedAt: new Date(now - 65 * 60000).toISOString()
    },
    {
      id: 6,
      username: "elliot",
      latitude: 51.5072,
      longitude: -0.1276,
      image: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=400",
      timezone: "Europe/London",
      locationUpdatedAt: new Date(now - 90 * 60000).toISOString()
    },
    {
      id: 7,
      username: "zoe",
      latitude: 48.8566,
      longitude: 2.3522,
      image: "https://images.unsplash.com/photo-1529139574466-a303027c1d8b?w=400",
      timezone: "Europe/Paris",
      locationUpdatedAt: new Date(now - 110 * 60000).toISOString()
    },
    {
      id: 8,
      username: "kai",
      latitude: 19.0760,
      longitude: 72.8777,
      image: "https://images.unsplash.com/photo-1501196354995-cbb51c65aaea?w=400",
      timezone: "Asia/Kolkata",
      locationUpdatedAt: new Date(now - 140 * 60000).toISOString()
    },
    {
      id: 9,
      username: "ivy",
      latitude: 48.2140,
      longitude: 16.3700,
      image: "https://images.unsplash.com/photo-1517841905240-472988babdf9?w=400",
      timezone: "Europe/Vienna",
      locationUpdatedAt: new Date(now - 160 * 60000).toISOString()
    },
    {
      id: 10,
      username: "theo",
      latitude: 48.2010,
      longitude: 16.3600,
      image: "https://images.unsplash.com/photo-1504257432389-52343af06ae3?w=400",
      timezone: "Europe/Vienna",
      locationUpdatedAt: new Date(now - 200 * 60000).toISOString()
    }
  ];
}






function renderPins(pins) {
  if (!state.map || !state.markers) {
    return;
  }

  const previousCount = state.pins.length;

  state.pins = pins;

  state.markers.clearLayers();

  const icon = createPinIcon();

  const bounds = [];

  for (const pin of pins) {
    if (!validCoordinates(pin.latitude, pin.longitude)) {
      continue;
    }

    const marker = L.marker(
      [pin.latitude, pin.longitude],
      {
        icon,
        keyboard: true,
        title: `Ping: ${pin.username}`
      }
    );

    marker.bindPopup(
      createPopup(pin),
      {
        maxWidth: 240,
        closeButton: true,
        autoPan: true
      }
    );

    // Asztali gépen az egér fölé vitele is megnyitja.
    marker.on("mouseover", () => {
      if (window.matchMedia("(hover: hover)").matches) {
        marker.openPopup();
      }
    });

    // Mobilon a koppintás a Leaflet alapértelmezett
    // viselkedése szerint nyitja meg a popupot.
    state.markers.addLayer(marker);

    bounds.push([pin.latitude, pin.longitude]);
  }

  $("#ping-count").textContent = pins.length.toLocaleString(
    navigator.language || "hu-HU"
  );

  $("#map-ping-count").textContent = pins.length.toLocaleString(
    navigator.language || "hu-HU"
  );

  $("#map-loading").classList.add("is-done");

  if (previousCount !== pins.length) {
    $("#ping-count").classList.remove("count-bump");

    void $("#ping-count").offsetWidth;

    $("#ping-count").classList.add("count-bump");
  }
}



async function refreshPins() {
  try {
    // Mintapingek betöltése.
    const demoPins = getDemoPins();

    // A felhasználók által helyben mentett pingek betöltése.
    const savedPins = JSON.parse(
      localStorage.getItem("ping_demo_pins") || "[]"
    );

    // A mentett pingek felhasználónként felülírják a mintapingeket,
    // ha ugyanahhoz a felhasználóhoz tartoznak.
    const pinsByUser = new Map();

    demoPins.forEach(pin => {
      pinsByUser.set(pin.username, pin);
    });

    savedPins.forEach(pin => {
      pinsByUser.set(pin.username, pin);
    });

    const pins = Array.from(pinsByUser.values());

    renderPins(pins);

    const loading = $("#map-loading");

    if (loading) {
      loading.classList.add("is-done");
    }
  } catch (error) {
    console.error("A pingek betöltése sikertelen:", error);

    const loading = $("#map-loading");

    if (loading) {
      loading.textContent =
        "A pingek betöltése nem sikerült. Frissítsd az oldalt.";
    }
  }
}




function fitAllPins() {
  if (!state.map || !state.markers) {
    return;
  }

  const layers = state.markers.getLayers();

  if (layers.length === 0) {
    state.map.setView([25, 10], 2);
    return;
  }

  const bounds = state.markers.getBounds();

  if (bounds.isValid()) {
    state.map.fitBounds(bounds, {
      padding: [45, 45],
      maxZoom: 12,
      animate: true
    });
  }
}


// --------------------------------------------------
// FELHASZNÁLÓI ÁLLAPOT
// --------------------------------------------------

function updateUserInterface() {
  const loggedIn = Boolean(state.user);

  $("#auth-open").classList.toggle(
    "hidden",
    loggedIn
  );

  $("#profile-open").classList.toggle(
    "hidden",
    !loggedIn
  );

  $("#avatar-letter").textContent = loggedIn
    ? state.user.username.charAt(0).toUpperCase()
    : "P";

  $("#hero-join").textContent = loggedIn
    ? "Saját pingem ↗"
    : "Csatlakozom ↗";

  $("#bottom-join").textContent = loggedIn
    ? "Saját pingem kezelése ↗"
    : "Legyél te a következő ping! ↗";

  $("#mobile-join").querySelector("small").textContent =
    loggedIn ? "Profil" : "Csatlakozás";

  if (loggedIn) {
    $("#auth-open").setAttribute("aria-label", "Bejelentkezve");
  }
}


async function loadCurrentUser() {
  try {
    const email = localStorage.getItem(
      "ping-demo-current-user"
    );

    const users = JSON.parse(
      localStorage.getItem("ping-demo-users") || "{}"
    );

    const user = email ? users[email] : null;

    state.user = user
      ? {
          username: user.username,
          hasLocation: user.hasLocation
        }
      : null;

    updateUserInterface();

  } catch (error) {
    console.error("A demófelhasználó betöltése sikertelen:", error);

    state.user = null;
    updateUserInterface();
  }
}


// --------------------------------------------------
// AUTH MODÁLIS
// --------------------------------------------------

function setAuthMode(mode) {
  state.authMode = mode;

  const isRegister = mode === "register";

  document.querySelectorAll("[data-auth-mode]").forEach(button => {
    button.classList.toggle(
      "active",
      button.dataset.authMode === mode
    );
  });

  $("#username-group").classList.toggle(
    "hidden",
    !isRegister
  );

  $("#auth-username").required = isRegister;

  $("#auth-password").autocomplete = isRegister
    ? "new-password"
    : "current-password";

  $("#auth-title").textContent = isRegister
    ? "Your story starts here."
    : "Welcome back.";

  $("#auth-eyebrow").textContent = isRegister
    ? "JOIN THE EXPERIMENT"
    : "GOOD TO SEE YOU";

  $("#auth-description").textContent = isRegister
    ? "Hozd létre a fiókodat, és csatlakozz a világtérképhez."
    : "Jelentkezz be, és folytasd a kalandot.";

  $("#auth-submit").textContent = isRegister
    ? "Fiók létrehozása ↗"
    : "Bejelentkezés ↗";

  setError("#auth-error");
}


async function handleAuthSubmit(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const button = $("#auth-submit");

  setError("#auth-error");

  const formData = new FormData(form);

  const email = String(formData.get("email") || "")
    .trim()
    .toLowerCase();

  const password = String(formData.get("password") || "");

  const username = String(formData.get("username") || "")
    .trim();

  setBusy(button, true);

  try {
    // A demófelhasználók kizárólag ebben a böngészőben élnek.
    const storageKey = "ping-demo-users";

    const users = JSON.parse(
      localStorage.getItem(storageKey) || "{}"
    );

    if (state.authMode === "register") {
      if (!username) {
        throw new Error("Adj meg egy felhasználónevet.");
      }

      if (!email || !password) {
        throw new Error("Töltsd ki az összes kötelező mezőt.");
      }

      if (password.length < 6) {
        throw new Error(
          "A jelszónak legalább 6 karakter hosszúnak kell lennie."
        );
      }

      if (users[email]) {
        throw new Error(
          "Ezzel az e-mail-címmel már regisztráltál ebben a demóban."
        );
      }

      // FIGYELEM: ez csak ideiglenes demómegoldás.
      // Valódi alkalmazásban jelszót nem tárolunk így.
      users[email] = {
        username,
        password,
        hasLocation: false
      };

      localStorage.setItem(
        storageKey,
        JSON.stringify(users)
      );

    } else {
      const user = users[email];

      if (!user || user.password !== password) {
        throw new Error(
          "Hibás e-mail-cím vagy jelszó."
        );
      }
    }

    const user = users[email];

    state.user = {
      username: user.username,
      hasLocation: user.hasLocation
    };

    localStorage.setItem(
      "ping-demo-current-user",
      email
    );

    updateUserInterface();

    closeModal($("#auth-modal"));
    form.reset();

    showToast(
      state.authMode === "register"
        ? "Sikeres demóregisztráció! Üdv a PING világában!"
        : "Sikeres demóbejelentkezés!"
    );

    openModal("profile-modal");

  } catch (error) {
    setError("#auth-error", error.message);
  } finally {
    setBusy(button, false);
  }
}

// --------------------------------------------------
// HELYMEGHATÁROZÁS
// --------------------------------------------------

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(
        new Error(
          "A böngésződ nem támogatja a helymeghatározást."
        )
      );

      return;
    }

    navigator.geolocation.getCurrentPosition(
      position => resolve(position),
      error => {
        const messages = {
          1: "A helymeghatározás engedélyezése szükséges.",
          2: "A helyzeted jelenleg nem határozható meg.",
          3: "A helymeghatározás időtúllépés miatt leállt."
        };

        reject(
          new Error(
            messages[error.code] ||
            "A helymeghatározás nem sikerült."
          )
        );
      },
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 60000
      }
    );
  });
}


async function handleGetLocation() {
  const button = $("#get-location");

  setError("#profile-error");

  button.disabled = true;

  const originalText = button.textContent;

  button.textContent = "Helymeghatározás...";

  try {
    const position = await getCurrentPosition();

    const latitude = position.coords.latitude;
    const longitude = position.coords.longitude;

    $("#latitude").value = latitude.toFixed(6);
    $("#longitude").value = longitude.toFixed(6);

    $("#location-hint").textContent =
      "A GPS-koordinátákat sikeresen meghatároztuk.";

    if (state.map) {
      state.map.setView([latitude, longitude], 12, {
        animate: true
      });
    }

    showToast("A helyzeted sikeresen meghatározva.");

  } catch (error) {
    setError("#profile-error", error.message);

  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}


async function handleLocateMe() {
  try {
    const position = await getCurrentPosition();

    const latitude = position.coords.latitude;
    const longitude = position.coords.longitude;

    state.map.setView(
      [latitude, longitude],
      12,
      { animate: true }
    );

  } catch (error) {
    showToast(error.message);
  }
}


// --------------------------------------------------
// KÉPFELTÖLTÉS ÉS ELŐNÉZET
// --------------------------------------------------

function handleImagePreview(event) {
  const file = event.target.files?.[0];

  const preview = $("#image-preview");

  if (state.imagePreviewUrl) {
    URL.revokeObjectURL(state.imagePreviewUrl);
    state.imagePreviewUrl = null;
  }

  preview.classList.add("hidden");
  preview.removeAttribute("src");

  if (!file) {
    return;
  }

  const allowedTypes = [
    "image/jpeg",
    "image/png",
    "image/webp"
  ];

  if (!allowedTypes.includes(file.type)) {
    event.target.value = "";

    showToast(
      "Csak JPEG, PNG vagy WebP képet választhatsz."
    );

    return;
  }

  if (file.size > 5 * 1024 * 1024) {
    event.target.value = "";

    showToast("A kép legfeljebb 5 MB lehet.");

    return;
  }

  state.imagePreviewUrl = URL.createObjectURL(file);

  preview.src = state.imagePreviewUrl;

  preview.classList.remove("hidden");
}


// --------------------------------------------------
// PROFIL ÉS PING MENTÉSE
// --------------------------------------------------

function openProfileModal() {
  if (!state.user) {
    openModal("auth-modal");
    setAuthMode("register");
    return;
  }

  setError("#profile-error");

  $("#profile-form").reset();

  $("#image-preview").classList.add("hidden");

  if (state.imagePreviewUrl) {
    URL.revokeObjectURL(state.imagePreviewUrl);
    state.imagePreviewUrl = null;
  }

  $("#latitude").value = "";
  $("#longitude").value = "";

  $("#location-hint").textContent =
    "A pontos koordinátákat csak akkor mentjük, ha elküldöd a pingedet.";

  $("#profile-title").textContent =
    state.user.hasLocation
      ? "Update your ping."
      : "Drop your pin.";

  $("#profile-submit").textContent =
    state.user.hasLocation
      ? "Ping frissítése ✳"
      : "Ping létrehozása ✳";

  openModal("profile-modal");
}


async function handleProfileSubmit(event) {
  event.preventDefault();

  setError("#profile-error");

  if (!state.user) {
    setError("#profile-error", "A ping létrehozásához jelentkezz be.");
    return;
  }

  const latitude = Number($("#latitude").value);
  const longitude = Number($("#longitude").value);

  if (!validCoordinates(latitude, longitude)) {
    setError("#profile-error", "Adj meg érvényes földrajzi koordinátákat.");
    return;
  }

  if (!$("#location-consent").checked) {
    setError(
      "#profile-error",
      "A térképes közzétételhez jelöld be a hozzájárulást."
    );
    return;
  }

  const selectedImage = $("#profile-image").files[0];

  if (!selectedImage && !state.user.hasLocation) {
    setError("#profile-error", "Az első pingedhez tölts fel egy képet.");
    return;
  }

  const button = $("#profile-submit");
  setBusy(button, true, "Ping mentése...");

  try {
    const storageKey = "ping_demo_pins";
    const savedPins = JSON.parse(localStorage.getItem(storageKey) || "[]");

    let imageUrl = state.user.image || "";

    if (selectedImage) {
      if (!selectedImage.type.startsWith("image/")) {
        throw new Error("Kérlek, képfájlt válassz.");
      }

      if (selectedImage.size > 5 * 1024 * 1024) {
        throw new Error("A kép mérete legfeljebb 5 MB lehet.");
      }

      imageUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("A képet nem sikerült beolvasni."));

        reader.readAsDataURL(selectedImage);
      });
    }

    if (!imageUrl) {
      throw new Error("Kérlek, tölts fel egy képet a pingedhez.");
    }

    const pin = {
      id: crypto.randomUUID
        ? crypto.randomUUID()
        : String(Date.now()),
      username: state.user.username,
      latitude,
      longitude,
      image: imageUrl,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      createdAt: new Date().toISOString()
    };

    // A felhasználó korábbi pingjének frissítése.
    const updatedPins = savedPins.filter(
      item => item.username !== state.user.username
    );

    updatedPins.push(pin);

    localStorage.setItem(storageKey, JSON.stringify(updatedPins));

    state.user.hasLocation = true;
    localStorage.setItem("ping_demo_user", JSON.stringify(state.user));

    await refreshPins();

    closeModal($("#profile-modal"));

    showToast("A pinged megérkezett a térképre! ✳");

  } catch (error) {
    setError("#profile-error", error.message || "Nem sikerült menteni a pinget.");
  } finally {
    setBusy(button, false);
  }
}



// --------------------------------------------------
// PING ELREJTÉSE
// --------------------------------------------------

async function hidePing() {
  if (!state.user) {
    return;
  }

  const confirmed = window.confirm(
    "Biztosan elrejted a pingedet a nyilvános térképről?"
  );

  if (!confirmed) {
    return;
  }

  try {
    await api("/api/profile/hide", {
      method: "POST",
      body: JSON.stringify({})
    });

    await loadCurrentUser();

    await refreshPins();

    closeModal($("#profile-modal"));

    showToast("A pingedet elrejtettük a térképről.");

  } catch (error) {
    showToast(error.message);
  }
}


// --------------------------------------------------
// KIJELENTKEZÉS
// --------------------------------------------------

async function logout() {
  try {
    await api("/api/logout", {
      method: "POST",
      body: JSON.stringify({})
    });

    state.user = null;

    updateUserInterface();

    closeModal($("#profile-modal"));

    showToast("Sikeresen kijelentkeztél.");

  } catch (error) {
    showToast(error.message);
  }
}


// --------------------------------------------------
// ESEMÉNYEK
// --------------------------------------------------

function bindEvents() {
  $("#auth-open").addEventListener("click", () => {
    setAuthMode("login");
    openModal("auth-modal");
  });

  $("#hero-join").addEventListener("click", () => {
    if (state.user) {
      openProfileModal();
    } else {
      setAuthMode("register");
      openModal("auth-modal");
    }
  });

  $("#bottom-join").addEventListener("click", () => {
    if (state.user) {
      openProfileModal();
    } else {
      setAuthMode("register");
      openModal("auth-modal");
    }
  });

  $("#mobile-join").addEventListener("click", () => {
    if (state.user) {
      openProfileModal();
    } else {
      setAuthMode("register");
      openModal("auth-modal");
    }
  });

  $("#profile-open").addEventListener("click", () => {
    openProfileModal();
  });

  document.querySelectorAll("[data-auth-mode]").forEach(button => {
    button.addEventListener("click", () => {
      setAuthMode(button.dataset.authMode);
    });
  });

  document.querySelectorAll("[data-close-modal]").forEach(button => {
    button.addEventListener("click", () => {
      closeModal(button.closest(".modal-backdrop"));
    });
  });

  document.querySelectorAll(".modal-backdrop").forEach(modal => {
    modal.addEventListener("click", event => {
      if (event.target === modal) {
        closeModal(modal);
      }
    });
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      document.querySelectorAll(
        ".modal-backdrop:not(.hidden)"
      ).forEach(closeModal);
    }
  });

  $("#auth-form").addEventListener(
    "submit",
    handleAuthSubmit
  );

  $("#profile-form").addEventListener(
    "submit",
    handleProfileSubmit
  );

  $("#get-location").addEventListener(
    "click",
    handleGetLocation
  );

  $("#locate-me").addEventListener(
    "click",
    handleLocateMe
  );

  $("#profile-image").addEventListener(
    "change",
    handleImagePreview
  );

  $("#hide-ping").addEventListener(
    "click",
    hidePing
  );

  $("#logout-button").addEventListener(
    "click",
    logout
  );

  $("#map-reset").addEventListener(
    "click",
    fitAllPins
  );

  $("#refresh-pins").addEventListener(
    "click",
    refreshPins
  );

  document.querySelectorAll(".mobile-nav-item").forEach(item => {
    item.addEventListener("click", () => {
      document.querySelectorAll(".mobile-nav-item").forEach(nav => {
        nav.classList.remove("active");
      });

      item.classList.add("active");
    });
  });

  window.addEventListener("resize", () => {
    if (state.map) {
      state.map.invalidateSize();
    }
  });
}


// --------------------------------------------------
// INDÍTÁS
// --------------------------------------------------

async function init() {
  updateDateTime();

  setInterval(updateDateTime, 60 * 1000);

  bindEvents();

  initMap();

  setAuthMode("register");

  await loadCurrentUser();

  await refreshPins();

  // A térképet rendszeresen frissítjük.
  // Ez nem WebSocket, tehát nem azonnali valós idejű
  // push kommunikáció.
  state.refreshTimer = setInterval(
    refreshPins,
    15000
  );
}

document.addEventListener("DOMContentLoaded", init);