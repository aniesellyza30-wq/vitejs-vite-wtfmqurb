
import "./style.css";

/* =================================
   GOOGLE APPS SCRIPT CONNECTION
================================= */

const API_URL =
  "https://script.google.com/macros/s/AKfycbzX_0t6qybCDfWomBjf80P4SK7YACmgRCabgLxn67ZdWvLjPPo_uqX9KK4siPY7jhHrZA/exec";

const OWNER_KEY = "ellizzfallinloveOwnerTokens";
const LANGUAGE_KEY = "weddingLanguage";

const MAX_PHOTOS = 5;
const MAX_IMAGE_SIZE = 1000;
const TARGET_IMAGE_BYTES = 200 * 1024;

let selectedPhotos = [];
let memories = [];
let currentLanguage = localStorage.getItem(LANGUAGE_KEY) || "en";
let pendingUpload = null;

/* =================================
   ELEMENTS
================================= */

const photoInput = document.getElementById("photoInput");
const uploadForm = document.getElementById("uploadForm");
const guestName = document.getElementById("guestName");
const guestMessage = document.getElementById("guestMessage");
const previewContainer = document.getElementById("previewContainer");
const photoGallery = document.getElementById("photoGallery");
const uploadStatus = document.getElementById("uploadStatus");
const submitButton = document.getElementById("submitButton");

/* =================================
   OWNER TOKENS
================================= */

function getOwnerTokens() {
  try {
    return JSON.parse(localStorage.getItem(OWNER_KEY)) || {};
  } catch {
    return {};
  }
}

function saveOwnerToken(id, token) {
  const tokens = getOwnerTokens();
  tokens[id] = token;
  localStorage.setItem(OWNER_KEY, JSON.stringify(tokens));
}

function getOwnerToken(id) {
  return getOwnerTokens()[id] || "";
}

function removeOwnerToken(id) {
  const tokens = getOwnerTokens();
  delete tokens[id];
  localStorage.setItem(OWNER_KEY, JSON.stringify(tokens));
}

/* =================================
   HELPERS
================================= */

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[character]);
}

function setStatus(message) {
  uploadStatus.textContent = message;
}

function normalizeMemory(memory) {
  const photos = memory.photos || memory.photoUrls || [];

  return {
    id: memory.id || memory.ID,
    name: memory.name || memory.guestName || "",
    message: memory.message || memory.guestMessage || "",
    photos: photos.map((photo) => {
      if (typeof photo === "string") return photo;
      return photo.url || photo.thumbnailUrl || photo.src || "";
    }).filter(Boolean),
    date: memory.date || memory.createdAt || memory.timestamp || ""
  };
}

/* =================================
   IMAGE COMPRESSION
================================= */


function compressImage(file) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      reject(new Error("Please select an image file."));
      return;
    }

    const image = new Image();
    const objectUrl = URL.createObjectURL(file);

    image.onload = async () => {
      try {
        let scale = Math.min(
          1,
          MAX_IMAGE_SIZE / Math.max(image.width, image.height)
        );

        let compressedBlob = null;

        for (let attempt = 0; attempt < 8; attempt++) {
          const canvas = document.createElement("canvas");

          canvas.width = Math.max(1, Math.round(image.width * scale));
          canvas.height = Math.max(1, Math.round(image.height * scale));

          const context = canvas.getContext("2d");

          context.drawImage(
            image,
            0,
            0,
            canvas.width,
            canvas.height
          );

          const quality = Math.max(0.35, 0.72 - attempt * 0.06);

          compressedBlob = await new Promise((resolveBlob) => {
            canvas.toBlob(resolveBlob, "image/jpeg", quality);
          });

          if (!compressedBlob) {
            throw new Error("Unable to process this photo.");
          }

          if (compressedBlob.size <= TARGET_IMAGE_BYTES) {
            break;
          }

          scale *= 0.82;
        }

        URL.revokeObjectURL(objectUrl);

        if (!compressedBlob) {
          throw new Error("Unable to process this photo.");
        }

        if (compressedBlob.size > 600 * 1024) {
          throw new Error(
            "This photo is too large. Please choose another photo."
          );
        }

        const reader = new FileReader();

        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(
          new Error("Unable to read this photo.")
        );

        reader.readAsDataURL(compressedBlob);

      } catch (error) {
        URL.revokeObjectURL(objectUrl);
        reject(error);
      }
    };

    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Unable to load this photo."));
    };

    image.src = objectUrl;
  });
}

/* =================================
   GOOGLE APPS SCRIPT - GET GALLERY
================================= */

function loadMemories() {
  return new Promise((resolve, reject) => {
    const callbackName =
      "ellizzGallery_" + Date.now() + "_" +
      Math.random().toString(36).slice(2);

    const script = document.createElement("script");

    const cleanup = () => {
      delete window[callbackName];
      script.remove();
    };

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Unable to load the gallery. Please refresh."));
    }, 30000);

    window[callbackName] = (response) => {
      clearTimeout(timeout);
      cleanup();

      if (response && response.success === false) {
        reject(new Error(response.message || "Unable to load gallery."));
        return;
      }

      const list =
        Array.isArray(response) ? response :
        response?.memories || response?.data || [];

      resolve(list.map(normalizeMemory));
    };

    script.onerror = () => {
      clearTimeout(timeout);
      cleanup();
      reject(new Error("Unable to connect to the gallery."));
    };

    script.src =
      `${API_URL}?action=list&callback=${callbackName}&_=${Date.now()}`;

    document.body.appendChild(script);
  });
}

/* =================================
   GOOGLE APPS SCRIPT - POST
   Hidden iframe method
================================= */

function sendToGoogle(payload) {
  return new Promise((resolve, reject) => {
    if (pendingUpload) {
      reject(new Error("Another request is still processing."));
      return;
    }

    const iframeName =
      "ellizzUploadFrame_" + Date.now();

    const iframe = document.createElement("iframe");
    iframe.name = iframeName;
    iframe.style.display = "none";

    const form = document.createElement("form");
    form.method = "POST";
    form.action = API_URL;
    form.target = iframeName;
    form.style.display = "none";

    const input = document.createElement("input");
    input.type = "hidden";
    input.name = "payload";
    input.value = JSON.stringify(payload);

    form.appendChild(input);

    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error("Upload is taking too long. Please try again.")
      );
    }, 90000);

    function cleanup() {
      clearTimeout(timeout);
      window.removeEventListener("message", handleMessage);
      form.remove();
      iframe.remove();
      pendingUpload = null;
    }

    function handleMessage(event) {
      const response = event.data;

      if (
        !response ||
        response.type !== "ELLIZZ_GUESTBOOK_RESPONSE"
      ) {
        return;
      }

      cleanup();

      const result = response.result;

      if (!result || result.success === false) {
        reject(
          new Error(result?.message || "Unable to save your memory.")
        );
        return;
      }

      resolve(result);
    }

    pendingUpload = { cleanup };

    window.addEventListener("message", handleMessage);

    document.body.appendChild(iframe);
    document.body.appendChild(form);

    form.submit();
  });
}

/* =================================
   PREVIEW
================================= */

function renderPreviews() {
  previewContainer.innerHTML = "";

  selectedPhotos.forEach((photo, index) => {
    const item = document.createElement("div");
    item.className = "preview-item";

    const image = document.createElement("img");
    image.src = photo;
    image.alt = `Photo preview ${index + 1}`;

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "remove-preview";
    removeButton.textContent = "×";
    removeButton.setAttribute("aria-label", "Remove photo");

    removeButton.addEventListener("click", () => {
      selectedPhotos.splice(index, 1);
      renderPreviews();
    });

    item.append(image, removeButton);
    previewContainer.appendChild(item);
  });
}

/* =================================
   PHOTO SELECTION
================================= */

photoInput.addEventListener("change", async () => {
  const files = Array.from(photoInput.files || []);

  if (!files.length) return;

  if (selectedPhotos.length + files.length > MAX_PHOTOS) {
    setStatus(`You can upload up to ${MAX_PHOTOS} photos.`);
    photoInput.value = "";
    return;
  }

  setStatus("Preparing your photos...");

  try {
    for (const file of files) {
      const compressedPhoto = await compressImage(file);
      selectedPhotos.push(compressedPhoto);
      renderPreviews();
    }

    setStatus("Your photos are ready!");
  } catch (error) {
    setStatus(error.message);
  }

  photoInput.value = "";
});

/* =================================
   RENDER GALLERY
================================= */

function renderGallery() {
  photoGallery.innerHTML = "";

  if (!memories.length) {
    photoGallery.innerHTML = `
      <div class="empty-gallery">
        <span>♡</span>
        <p>Your memories will appear here.</p>
        <small>Be the first to share a moment!</small>
      </div>
    `;

    applyEmptyGalleryLanguage();
    return;
  }

  memories.forEach((memory) => {
    const card = document.createElement("article");
    card.className = "polaroid";

    const photos = memory.photos || [];

    const imageMarkup = photos.map((photo, index) => `
      <div class="polaroid-image">
        <img
          src="${escapeHTML(photo)}"
          alt="Photo shared by ${escapeHTML(memory.name)}"
          loading="lazy"
          decoding="async"
        />
      </div>
    `).join("");

    const message = memory.message
      ? `<p>${escapeHTML(memory.message)}</p>`
      : "";

    const date = memory.date
      ? new Date(memory.date).toLocaleDateString("en-MY", {
          day: "numeric",
          month: "short",
          year: "numeric"
        })
      : "";

    const isOwner = Boolean(getOwnerToken(memory.id));

    card.innerHTML = `
      ${imageMarkup}

      <div class="polaroid-caption">
        <h3>${escapeHTML(memory.name)}</h3>
        ${message}
        <span class="polaroid-date">${escapeHTML(date)}</span>
      </div>

      ${
        isOwner
          ? `
            <div class="photo-actions">
              <button type="button" class="edit-button">Edit</button>
              <button type="button" class="delete-button">Delete</button>
            </div>
          `
          : ""
      }
    `;

    if (isOwner) {
      card.querySelector(".edit-button").addEventListener("click", () => {
        editMemory(memory.id);
      });

      card.querySelector(".delete-button").addEventListener("click", () => {
        deleteMemory(memory.id);
      });
    }

    photoGallery.appendChild(card);
  });
}

/* =================================
   EDIT MEMORY
================================= */

async function editMemory(id) {
  const memory = memories.find((item) => item.id === id);
  const ownerToken = getOwnerToken(id);

  if (!memory || !ownerToken) return;

  const newName = prompt("Edit your name:", memory.name);
  if (newName === null) return;

  const newMessage = prompt(
    "Edit your wishes:",
    memory.message || ""
  );

  if (newMessage === null) return;

  try {
    setStatus("Updating your memory...");

    const result = await sendToGoogle({
      action: "edit",
      id,
      ownerToken,
      name: newName.trim() || memory.name,
      message: newMessage.trim()
    });

    await refreshGallery();

    setStatus("Your memory has been updated! ♡");

  } catch (error) {
    setStatus(error.message);
  }
}

/* =================================
   DELETE MEMORY
================================= */

async function deleteMemory(id) {
  const confirmed = confirm(
    "Are you sure you want to delete this memory?"
  );

  if (!confirmed) return;

  const ownerToken = getOwnerToken(id);

  if (!ownerToken) {
    setStatus("You do not have permission to delete this memory.");
    return;
  }

  try {
    setStatus("Deleting your memory...");

    await sendToGoogle({
      action: "delete",
      id,
      ownerToken
    });

    removeOwnerToken(id);
    await refreshGallery();

    setStatus("Your memory has been deleted.");

  } catch (error) {
    setStatus(error.message);
  }
}

/* =================================
   REFRESH GALLERY
================================= */

async function refreshGallery() {
  memories = await loadMemories();
  renderGallery();
}

/* =================================
   SUBMIT MEMORY
================================= */

uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const name = guestName.value.trim();
  const message = guestMessage.value.trim();

  if (!name) {
    setStatus("Please enter your name.");
    return;
  }

  if (!selectedPhotos.length) {
    setStatus("Please choose at least one photo.");
    return;
  }

  submitButton.disabled = true;
  submitButton.textContent = "Sharing your memories...";

  try {
    setStatus("Uploading your memories... Please wait ♡");

    const result = await sendToGoogle({
      action: "create",
      name,
      message,
      photos: [...selectedPhotos]
    });

    const createdMemory =
      result.memory || result.data || result;

    const memoryId =
      createdMemory.id || result.id;

    const ownerToken =
      createdMemory.ownerToken || result.ownerToken;

    if (memoryId && ownerToken) {
      saveOwnerToken(memoryId, ownerToken);
    }

    uploadForm.reset();
    selectedPhotos = [];
    renderPreviews();

    await refreshGallery();

    setStatus("Your memories have been added! ♡");

    document.querySelector(".gallery-section").scrollIntoView({
      behavior: "smooth"
    });

  } catch (error) {
    setStatus(error.message);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent =
      translations[currentLanguage].shareButton;
  }
});

/* =================================
   LANGUAGE SWITCHER
================================= */

const translations = {
  en: {
    eyebrow: "THE WEDDING GUESTBOOK",
    subtitle: "Forever Begins Here",
    description: "A little space for your lovely photos, wishes and memories.",
    description2: "Share a moment with us and let us keep it forever.",
    uploadEyebrow: "CAPTURE THE MOMENT",
    uploadTitle: "Share Your Memories",
    uploadDescription: "Upload your photo and leave us a little note.",
    nameLabel: "Your Name",
    namePlaceholder: "Enter your name",
    wishesLabel: "Your Wishes",
    wishesPlaceholder: "Write a lovely wish for the newlyweds...",
    photosLabel: "Your Photos",
    choosePhotos: "Choose Your Photos",
    photoLimit: "Tap here to upload up to 5 photos",
    photoFormat: "JPG, PNG or WEBP",
    shareButton: "Share Your Memories",
    galleryEyebrow: "A COLLECTION OF LOVE",
    galleryTitle: "Our Memories",
    galleryDescription: "Every photo tells a beautiful story.",
    emptyTitle: "Your memories will appear here.",
    emptyDescription: "Be the first to share a moment!",
    footerMessage: "Thank you for being part of our special day."
  },

  bm: {
    eyebrow: "BUKU TETAMU PERKAHWINAN",
    subtitle: "Bermulanya Selamanya",
    description: "Ruang khas untuk gambar, ucapan dan kenangan indah anda.",
    description2: "Kongsikan momen bersama kami untuk disimpan selamanya.",
    uploadEyebrow: "ABADIKAN MOMEN",
    uploadTitle: "Kongsikan Kenangan Anda",
    uploadDescription: "Muat naik gambar dan tinggalkan ucapan buat kami.",
    nameLabel: "Nama Anda",
    namePlaceholder: "Masukkan nama anda",
    wishesLabel: "Ucapan Anda",
    wishesPlaceholder: "Tuliskan ucapan indah buat pasangan pengantin...",
    photosLabel: "Gambar Anda",
    choosePhotos: "Pilih Gambar",
    photoLimit: "Tekan di sini untuk muat naik sehingga 5 gambar",
    photoFormat: "JPG, PNG atau WEBP",
    shareButton: "Kongsikan Kenangan",
    galleryEyebrow: "KOLEKSI KENANGAN",
    galleryTitle: "Kenangan Kami",
    galleryDescription: "Setiap gambar menyimpan sebuah cerita indah.",
    emptyTitle: "Kenangan anda akan dipaparkan di sini.",
    emptyDescription: "Jadilah yang pertama berkongsi kenangan!",
    footerMessage: "Terima kasih kerana menjadi sebahagian daripada hari istimewa kami."
  }
};

function applyEmptyGalleryLanguage() {
  const t = translations[currentLanguage];
  const empty = photoGallery.querySelector(".empty-gallery");

  if (!empty) return;

  empty.querySelector("p").textContent = t.emptyTitle;
  empty.querySelector("small").textContent = t.emptyDescription;
}

function changeLanguage(language) {
  const t = translations[language];

  if (!t) return;

  currentLanguage = language;
  document.documentElement.lang = language;

  document.querySelector(".hero .eyebrow").textContent = t.eyebrow;
  document.querySelector(".hero-subtitle").textContent = t.subtitle;

  document.querySelector(".hero-description").innerHTML = `
    ${t.description}<br>${t.description2}
  `;

  document.querySelector(".upload-section .eyebrow").textContent = t.uploadEyebrow;
  document.querySelector(".upload-section h2").textContent = t.uploadTitle;
  document.querySelector(".upload-section .section-heading > p:last-child").textContent = t.uploadDescription;

  document.querySelector('label[for="guestName"]').textContent = t.nameLabel;
  guestName.placeholder = t.namePlaceholder;

  document.querySelector('label[for="guestMessage"]').textContent = t.wishesLabel;
  guestMessage.placeholder = t.wishesPlaceholder;

  document.querySelectorAll(".field-label")[2].textContent = t.photosLabel;

  document.querySelector(".upload-box strong").textContent = t.choosePhotos;
  document.querySelector(".upload-box span:not(.upload-icon)").textContent = t.photoLimit;
  document.querySelector(".upload-box small").textContent = t.photoFormat;

  submitButton.textContent = t.shareButton;

  document.querySelector(".gallery-section .eyebrow").textContent = t.galleryEyebrow;
  document.querySelector(".gallery-section h2").textContent = t.galleryTitle;
  document.querySelector(".gallery-section .section-heading > p:last-child").textContent = t.galleryDescription;

  document.querySelector(".footer small").textContent = t.footerMessage;

  document.getElementById("langEN").classList.toggle("active", language === "en");
  document.getElementById("langBM").classList.toggle("active", language === "bm");

  renderGallery();
  localStorage.setItem(LANGUAGE_KEY, language);
}

document.getElementById("langEN").addEventListener("click", () => {
  changeLanguage("en");
});

document.getElementById("langBM").addEventListener("click", () => {
  changeLanguage("bm");
});

/* =================================
   START WEBSITE
================================= */

changeLanguage(currentLanguage);

setStatus("Loading memories...");

refreshGallery()
  .then(() => {
    setStatus("");
  })
  .catch((error) => {
    console.error(error);
    setStatus("Unable to load memories. Please refresh the page.");
  });
