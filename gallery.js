'use strict';

const galleryView = document.querySelector('#gallery-view');
const galleryColumns = document.querySelector('#gallery-columns');
const galleryStatus = document.querySelector('#gallery-status');
const galleryTabs = Array.from(document.querySelectorAll('.gallery-tab'));
const galleryPhotosPanel = document.querySelector('#gallery-photos-panel');
const galleryVideosPanel = document.querySelector('#gallery-videos-panel');
const galleryNavLink = document.querySelector('#gallery-nav-link');
const galleryBack = document.querySelector('#gallery-back');
const galleryLightbox = document.querySelector('#gallery-lightbox');
const galleryLightboxImage = document.querySelector('#gallery-lightbox-image');
const galleryLightboxCaption = document.querySelector('#gallery-lightbox-caption');
const galleryLightboxClose = document.querySelector('#gallery-lightbox-close');
const galleryEndpoint = document.querySelector('meta[name="gallery-api-endpoint"]').content.trim();
const galleryHomeParts = [
  document.querySelector('.masthead'),
  document.querySelector('.portrait'),
  document.querySelector('.statement')
];
const galleryReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let galleryPhotos = [];
let galleryLoadPromise = null;
let galleryActive = false;
let gallerySwitching = false;
let galleryEntranceTimer;
let galleryResizeTimer;
let selectedGalleryCard = null;
let selectedGalleryColumn = null;
let renderedGalleryWidth = 0;
let renderedGalleryCount = 0;

function galleryColumnCount() {
  if (window.innerWidth < 600) return 3;
  if (window.innerWidth < 900) return 3;
  if (window.innerWidth < 1100) return 4;
  return 6;
}

function normalizeGalleryPhoto(entry, index) {
  if (!entry || typeof entry !== 'object' ||
      entry.active === false || entry.active === 0 || entry.active === '0' || entry.active === 'false') return null;
  const imagePath = typeof entry.image_url === 'string' && entry.image_url.trim()
    ? entry.image_url.trim()
    : entry.id != null ? '/api/gallery/image/' + encodeURIComponent(entry.id) : '';
  if (!imagePath) return null;
  try {
    const url = new URL(imagePath, galleryEndpoint || window.location.href);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return {
      id: entry.id ?? index,
      imageUrl: url.href,
      title: typeof entry.title === 'string' ? entry.title.trim() : '',
      sortOrder: Number.isFinite(Number(entry.sort_order)) ? Number(entry.sort_order) : index
    };
  } catch (error) {
    return null;
  }
}

async function loadGalleryPhotos() {
  if (galleryLoadPromise) return galleryLoadPromise;
  if (!galleryEndpoint) {
    galleryStatus.hidden = false;
    galleryStatus.textContent = 'GALERÍA AÚN NO DISPONIBLE';
    return;
  }
  galleryStatus.hidden = false;
  galleryStatus.textContent = 'CARGANDO GALERÍA...';
  galleryView.classList.add('is-loading');
  galleryLoadPromise = (async () => {
    try {
      const response = await fetch(galleryEndpoint, { cache: 'no-store' });
      if (!response.ok) throw new Error('Gallery API request failed: ' + response.status);
      const payload = await response.json();
      const entries = Array.isArray(payload) ? payload : payload.items;
      if (!Array.isArray(entries)) throw new Error('Invalid gallery response');
      galleryPhotos = entries
        .map(normalizeGalleryPhoto)
        .filter(Boolean)
        .sort((a, b) => a.sortOrder - b.sortOrder);
      galleryStatus.hidden = galleryPhotos.length > 0;
      if (!galleryPhotos.length) galleryStatus.textContent = 'AÚN NO HAY FOTOGRAFÍAS';
      renderGalleryColumns();
    } catch (error) {
      console.error('Unable to load gallery:', error);
      galleryPhotos = [];
      galleryColumns.replaceChildren();
      galleryView.classList.remove('is-running');
      galleryStatus.hidden = false;
      galleryStatus.textContent = 'NO SE PUDO CARGAR LA GALERÍA';
    } finally {
      galleryView.classList.remove('is-loading');
      galleryLoadPromise = null;
    }
  })();
  return galleryLoadPromise;
}

function makeGalleryCard(photo, photoIndex, visualCopy, eager) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'gallery-photo';
  card.dataset.photoIndex = String(photoIndex);
  card.setAttribute('aria-label', 'Ampliar fotografía' + (photo.title ? ': ' + photo.title : ''));
  if (visualCopy) card.tabIndex = -1;
  const image = document.createElement('img');
  image.src = photo.imageUrl;
  image.alt = visualCopy ? '' : (photo.title || 'Fotografía de galería');
  image.loading = eager ? 'eager' : 'lazy';
  image.decoding = 'async';
  card.append(image);
  return card;
}

function renderGalleryColumns() {
  window.clearTimeout(galleryEntranceTimer);
  galleryView.classList.remove('is-running');
  galleryColumns.classList.remove('is-entered');
  galleryColumns.replaceChildren();
  if (!galleryPhotos.length) return;

  const count = galleryColumnCount();
  renderedGalleryCount = count;
  renderedGalleryWidth = window.innerWidth;
  galleryColumns.style.setProperty('--gallery-count', String(count));
  const groups = Array.from({ length: count }, () => {
    const indices = galleryPhotos.map((photo, index) => index);
    // Each column draws from the entire gallery, in its own shuffled order.
    for (let index = indices.length - 1; index > 0; index--) {
      const randomIndex = Math.floor(Math.random() * (index + 1));
      [indices[index], indices[randomIndex]] = [indices[randomIndex], indices[index]];
    }
    return indices;
  });
  const width = Math.min(window.innerWidth - 32, 1280) / count;
  const minimumItems = Math.ceil(window.innerHeight / Math.max(70, width * .7)) + 2;

  groups.forEach((indices, columnIndex) => {
    const sourceIndices = indices;
    const displayedIndices = sourceIndices.slice();
    // Complete cycles preserve a seamless loop without adjacent duplicate photos.
    while (displayedIndices.length < minimumItems) {
      displayedIndices.push(...sourceIndices);
    }
    const column = document.createElement('div');
    column.className = 'gallery-column';
    column.dataset.direction = columnIndex % 2 === 0 ? 'up' : 'down';
    column.style.setProperty('--column-index', String(columnIndex));
    const track = document.createElement('div');
    track.className = 'gallery-track';
    track.style.setProperty('--travel-duration',
      Math.max(32, Math.round(displayedIndices.length * width / 18)) + 's');
    for (let copy = 0; copy < 2; copy++) {
      const set = document.createElement('div');
      set.className = 'gallery-set';
      if (copy) set.setAttribute('aria-hidden', 'true');
      displayedIndices.forEach((photoIndex, position) => {
        set.append(makeGalleryCard(
          galleryPhotos[photoIndex], photoIndex, copy === 1 || position >= sourceIndices.length,
          position < 2 && copy === columnIndex % 2
        ));
      });
      track.append(set);
    }
    column.append(track);
    galleryColumns.append(column);
  });
  if (galleryActive && !galleryView.hidden) enterGalleryColumns();
}

function syncGalleryMotion() {
  document.dispatchEvent(new Event('gallery-view-change'));
  galleryView.classList.toggle('is-running',
    galleryActive && !galleryView.hidden && !galleryPhotosPanel.hidden && galleryColumns.classList.contains('is-entered') &&
    !galleryReducedMotion.matches && document.visibilityState !== 'hidden');
}

function enterGalleryColumns() {
  galleryColumns.classList.remove('is-entered');
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      if (!galleryActive || galleryView.hidden) return;
      galleryColumns.classList.add('is-entered');
      window.clearTimeout(galleryEntranceTimer);
      galleryEntranceTimer = window.setTimeout(syncGalleryMotion,
        galleryReducedMotion.matches ? 0 : 700 + (renderedGalleryCount - 1) * 55);
    });
  });
}

function waitForGalleryFade() {
  return new Promise((resolve) => window.setTimeout(resolve, galleryReducedMotion.matches ? 0 : 360));
}

async function showGallery() {
  if (gallerySwitching || galleryActive) return;
  gallerySwitching = true;
  galleryActive = true;
  const poster = document.querySelector('#poster');
  poster.classList.add('view-switching', 'gallery-open');
  galleryView.classList.add('is-loading');
  await waitForGalleryFade();
  galleryHomeParts.forEach((part) => { part.hidden = true; });
  poster.classList.add('gallery-layout');
  document.body.classList.add('gallery-page-open');
  galleryView.hidden = false;
  window.requestAnimationFrame(() => {
    galleryView.classList.add('is-visible');
    galleryView.scrollIntoView({
      behavior: 'instant',
      block: 'start'
    });
  });
  galleryNavLink.setAttribute('aria-current', 'page');
  galleryBack.focus({ preventScroll: true });
  await loadGalleryPhotos();

  gallerySwitching = false;
}

async function showHome() {
  if (gallerySwitching || !galleryActive) return;
  gallerySwitching = true;
  closeGalleryLightbox();
  galleryActive = false;
  document.dispatchEvent(new Event('gallery-view-change'));
  galleryView.classList.remove('is-visible', 'is-running');
  galleryColumns.classList.remove('is-entered');
  window.clearTimeout(galleryEntranceTimer);
  await waitForGalleryFade();
  galleryView.hidden = true;
  document.querySelector('#poster').classList.remove('gallery-layout');
  document.body.classList.remove('gallery-page-open');
  galleryHomeParts.forEach((part) => { part.hidden = false; });
  window.requestAnimationFrame(() => {
    const poster = document.querySelector('#poster');
    poster.classList.remove('gallery-open');
    poster.scrollIntoView({
      behavior: galleryReducedMotion.matches ? 'auto' : 'smooth',
      block: 'start'
    });
  });
  galleryNavLink.removeAttribute('aria-current');
  document.querySelector('#poster').focus({ preventScroll: true });
  gallerySwitching = false;
}

function openGalleryLightbox(card) {
  const photo = galleryPhotos[Number(card.dataset.photoIndex)];
  if (!photo) return;
  selectedGalleryCard = card;
  selectedGalleryColumn = card.closest('.gallery-column');
  selectedGalleryCard.classList.add('is-selected');
  selectedGalleryColumn.classList.add('is-paused');
  galleryLightboxImage.src = photo.imageUrl;
  galleryLightboxImage.alt = photo.title || 'Fotografía de galería';
  galleryLightboxCaption.textContent = photo.title;
  galleryLightboxCaption.hidden = !photo.title;
  galleryLightbox.hidden = false;
  document.body.classList.add('gallery-lightbox-open');
  galleryLightboxClose.focus({ preventScroll: true });
}

function closeGalleryLightbox() {
  if (galleryLightbox.hidden) return;
  galleryLightbox.hidden = true;
  document.body.classList.remove('gallery-lightbox-open');
  galleryLightboxImage.removeAttribute('src');
  if (selectedGalleryCard) selectedGalleryCard.classList.remove('is-selected');
  if (selectedGalleryColumn) selectedGalleryColumn.classList.remove('is-paused');
  selectedGalleryCard = null;
  selectedGalleryColumn = null;
  if (galleryActive) galleryBack.focus({ preventScroll: true });
}

function selectGalleryTab(tab) {
  if (!galleryTabs.includes(tab)) return;
  closeGalleryLightbox();
  const photosSelected = tab.id === 'gallery-photos-tab';
  galleryPhotosPanel.hidden = !photosSelected;
  galleryVideosPanel.hidden = photosSelected;
  galleryTabs.forEach((item) => {
    const selected = item === tab;
    item.setAttribute('aria-selected', String(selected));
    item.tabIndex = selected ? 0 : -1;
  });
  syncGalleryMotion();
}
galleryTabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectGalleryTab(tab));
  tab.addEventListener('keydown', (event) => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % galleryTabs.length;
    else if (event.key === 'ArrowLeft') next = (index + galleryTabs.length - 1) % galleryTabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = galleryTabs.length - 1;
    else return;
    event.preventDefault();
    selectGalleryTab(galleryTabs[next]);
    galleryTabs[next].focus();
  });
});

// Freeze a moving column at its current position before native internal scrolling.
function enableGalleryManualScroll(event) {
  const column = event.target.closest('.gallery-column');
  if (!column || column.classList.contains('is-manual')) return;
  if (event.type === 'pointerdown' && event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
  const track = column.querySelector('.gallery-track');
  const transform = getComputedStyle(track).transform;
  const offset = transform === 'none' ? 0 : Math.max(0, -new DOMMatrixReadOnly(transform).m42);
  column.classList.add('is-manual');
  column.scrollTop = offset;
}
galleryView.addEventListener('pointerdown', enableGalleryManualScroll, { passive: true });
galleryView.addEventListener('wheel', enableGalleryManualScroll, { passive: true });

galleryNavLink.addEventListener('click', (event) => {
  event.preventDefault();
  showGallery();
});
galleryBack.addEventListener('click', showHome);
galleryColumns.addEventListener('click', (event) => {
  const card = event.target.closest('.gallery-photo');
  if (card) openGalleryLightbox(card);
});
galleryLightboxClose.addEventListener('click', closeGalleryLightbox);
galleryLightbox.addEventListener('click', (event) => {
  if (!event.target.closest('.gallery-media-frame') && event.target !== galleryLightboxClose) closeGalleryLightbox();
});
galleryLightbox.addEventListener('keydown', (event) => {
  if (event.key === 'Tab') {
    event.preventDefault();
    const download = document.querySelector('#gallery-photo-download');
    const controls = download.disabled ? [galleryLightboxClose] : [galleryLightboxClose, download];
    const index = controls.indexOf(document.activeElement);
    controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length].focus();
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !galleryLightbox.hidden) closeGalleryLightbox();
});
document.addEventListener('visibilitychange', syncGalleryMotion);
galleryReducedMotion.addEventListener('change', syncGalleryMotion);
window.addEventListener('resize', () => {
  window.clearTimeout(galleryResizeTimer);
  galleryResizeTimer = window.setTimeout(() => {
    if (galleryPhotos.length && galleryActive &&
        (galleryColumnCount() !== renderedGalleryCount ||
         Math.abs(window.innerWidth - renderedGalleryWidth) > 40)) {
      closeGalleryLightbox();
      renderGalleryColumns();
    }
  }, 180);
}, { passive: true });