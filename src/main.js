const MAX_POINTS = 10;
const STORAGE_KEY = 'mapper:mvp:maps';
const SESSION_KEY = 'mapper:mvp:user';
const TILE_SOURCES = [
  {
    name: 'OSM Standard',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  },
  {
    name: 'CARTO Voyager',
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    maxZoom: 20,
  },
  {
    name: 'CARTO Positron',
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    maxZoom: 20,
  },
];

const app = document.querySelector('#app');
app.innerHTML = `
  <section id="login" class="login-card" hidden>
    <div>
      <p class="eyebrow">Mapper MVP</p>
      <h1>Vlastní mapové podklady nad reálnou mapou</h1>
      <p>Přihlášení je v MVP lokální, bez serveru. Slouží jen k oddělení pracovního prostoru v prohlížeči.</p>
    </div>
    <form id="login-form">
      <label>Jméno nebo e-mail <input id="login-name" required autocomplete="username" placeholder="např. petr@example.com" /></label>
      <button type="submit">Přihlásit se</button>
    </form>
  </section>

  <main id="workspace" hidden>
    <aside class="panel">
      <header>
        <p class="eyebrow">Mapper MVP</p>
        <h1>Kalibrace mapy</h1>
        <button id="logout" type="button" class="secondary">Odhlásit</button>
      </header>

      <section class="block">
        <h2>1. Podklad</h2>
        <label>Název <input id="map-title" placeholder="Název mapy" /></label>
        <label>Popis <textarea id="map-description" rows="3" placeholder="Poznámky, zdroj, verze…"></textarea></label>
        <label>Obrázek <input id="image-input" type="file" accept="image/*" /></label>
        <div class="row">
          <button id="new-map" type="button" class="secondary">Nová mapa</button>
          <button id="save-map" type="button">Uložit</button>
        </div>
      </section>

      <section class="block">
        <h2>2. Kalibrační body</h2>
        <p class="hint">Klikni bod ve vlastní mapě, potom stejný bod v reálné mapě. Minimum jsou 2 body, maximum 10.</p>
        <label>Průhlednost overlaye <input id="opacity" type="range" min="0" max="1" step="0.05" value="0.55" /></label>
        <div id="custom-map" class="custom-map"><span>Nahraj obrázek mapy</span></div>
        <p id="status" class="status">Čekám na obrázek.</p>
        <ol id="points"></ol>
        <button id="clear-points" type="button" class="secondary">Smazat body</button>
      </section>

      <section class="block">
        <h2>Uložené mapy</h2>
        <div id="saved-maps" class="saved-maps"></div>
      </section>
    </aside>
    <div id="map"></div>
  </main>
`;

let leafletMap;
let userMarker;
let customImage = null;
let customImageSize = null;
let pendingImagePoint = null;
let points = [];
let editingId = null;
let overlayLayer = null;
let imageMarkerLayer = null;
let realMarkerLayer = null;

const login = document.querySelector('#login');
const workspace = document.querySelector('#workspace');
const loginForm = document.querySelector('#login-form');
const logout = document.querySelector('#logout');
const imageInput = document.querySelector('#image-input');
const customMap = document.querySelector('#custom-map');
const statusEl = document.querySelector('#status');
const opacity = document.querySelector('#opacity');
const pointsEl = document.querySelector('#points');
const savedMapsEl = document.querySelector('#saved-maps');
const titleInput = document.querySelector('#map-title');
const descriptionInput = document.querySelector('#map-description');


class FallbackTileLayer extends L.TileLayer {
  createTile(coords, done) {
    const tile = super.createTile(coords, done);
    tile.dataset.retryIndex = '0';
    tile.addEventListener('error', () => this.retryTile(tile, coords), { passive: true });
    return tile;
  }

  retryTile(tile, coords) {
    const retryIndex = Number(tile.dataset.retryIndex || '0') + 1;
    if (retryIndex > TILE_SOURCES.length) return;
    tile.dataset.retryIndex = String(retryIndex);
    const source = TILE_SOURCES[retryIndex % TILE_SOURCES.length];
    tile.src = L.Util.template(source.url, {
      ...coords,
      s: this._getSubdomain(coords),
      r: L.Browser.retina ? '@2x' : '',
    }) + `?retry=${Date.now()}`;
  }
}

function createTileLayer(source) {
  return new FallbackTileLayer(source.url, {
    attribution: source.attribution,
    crossOrigin: true,
    detectRetina: true,
    keepBuffer: 4,
    maxNativeZoom: source.maxZoom,
    maxZoom: source.maxZoom,
    updateWhenIdle: false,
    updateWhenZooming: false,
  });
}

function refreshTiles() {
  leafletMap.eachLayer((layer) => {
    if (layer instanceof L.TileLayer) layer.redraw();
  });
}

class CalibratedImageOverlay extends L.Layer {
  onAdd(map) {
    this.map = map;
    this.img = L.DomUtil.create('img', 'calibrated-overlay leaflet-zoom-animated');
    this.img.src = customImage;
    this.img.style.opacity = opacity.value;
    this.img.style.width = `${customImageSize.width}px`;
    this.img.style.height = `${customImageSize.height}px`;
    map.getPanes().overlayPane.appendChild(this.img);
    map.on('zoom move viewreset', this.update, this);
    this.update();
  }

  onRemove(map) {
    map.off('zoom move viewreset', this.update, this);
    this.img?.remove();
  }

  update() {
    if (!this.img || points.length < 2) return;
    const pairs = points.map((point) => ({
      source: point.image,
      target: leafletMap.latLngToLayerPoint(point.latlng),
    }));
    const matrix = solveAffine(pairs);
    this.img.style.transformOrigin = '0 0';
    this.img.style.transform = `matrix(${matrix.a}, ${matrix.b}, ${matrix.c}, ${matrix.d}, ${matrix.e}, ${matrix.f})`;
  }
}

function solveAffine(pairs) {
  const normal = Array.from({ length: 6 }, () => Array(7).fill(0));
  for (const pair of pairs) {
    const { x, y } = pair.source;
    const { x: X, y: Y } = pair.target;
    addEquation(normal, [x, y, 0, 0, 1, 0], X);
    addEquation(normal, [0, 0, x, y, 0, 1], Y);
  }
  const solved = gaussian(normal);
  return { a: solved[0], c: solved[1], b: solved[2], d: solved[3], e: solved[4], f: solved[5] };
}

function addEquation(normal, coeffs, value) {
  for (let row = 0; row < coeffs.length; row++) {
    for (let col = 0; col < coeffs.length; col++) normal[row][col] += coeffs[row] * coeffs[col];
    normal[row][6] += coeffs[row] * value;
  }
}

function gaussian(matrix) {
  const n = 6;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(matrix[row][col]) > Math.abs(matrix[pivot][col])) pivot = row;
    }
    [matrix[col], matrix[pivot]] = [matrix[pivot], matrix[col]];
    const divisor = matrix[col][col] || 1e-12;
    for (let j = col; j <= n; j++) matrix[col][j] /= divisor;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = matrix[row][col];
      for (let j = col; j <= n; j++) matrix[row][j] -= factor * matrix[col][j];
    }
  }
  return matrix.map((row) => row[n]);
}

function boot() {
  const user = localStorage.getItem(SESSION_KEY);
  login.hidden = Boolean(user);
  workspace.hidden = !user;
  if (user) {
    initMap();
    setTimeout(() => leafletMap.invalidateSize(), 0);
  }
  renderSavedMaps();
}

function initMap() {
  if (leafletMap) return;
  leafletMap = L.map('map', { zoomControl: true }).setView([49.8175, 15.473], 7);
  const baseLayers = Object.fromEntries(TILE_SOURCES.map((source) => [source.name, createTileLayer(source)]));
  baseLayers['CARTO Voyager'].addTo(leafletMap);
  L.control.layers(baseLayers, null, { position: 'topright' }).addTo(leafletMap);

  const reloadControl = L.control({ position: 'topright' });
  reloadControl.onAdd = () => {
    const button = L.DomUtil.create('button', 'tile-refresh-button');
    button.type = 'button';
    button.textContent = 'Reload tiles';
    button.title = 'Znovu načíst mapové dlaždice';
    L.DomEvent.disableClickPropagation(button);
    L.DomEvent.on(button, 'click', refreshTiles);
    return button;
  };
  reloadControl.addTo(leafletMap);

  realMarkerLayer = L.layerGroup().addTo(leafletMap);
  leafletMap.on('click', (event) => {
    if (!pendingImagePoint || points.length >= MAX_POINTS) return;
    points.push({ image: pendingImagePoint, latlng: event.latlng });
    pendingImagePoint = null;
    status('Bod uložený. Vyber další bod ve vlastní mapě.');
    renderPoints();
    refreshOverlay();
  });
  requestLocation();
}


function requestLocation() {
  if (!navigator.geolocation) {
    status('Prohlížeč nepodporuje GPS polohu.');
    return;
  }
  navigator.geolocation.watchPosition(
    ({ coords }) => {
      const latlng = [coords.latitude, coords.longitude];
      if (!userMarker) {
        userMarker = L.marker(latlng).addTo(leafletMap).bindPopup('Moje GPS poloha');
        leafletMap.setView(latlng, 15);
      } else userMarker.setLatLng(latlng);
    },
    () => status('GPS poloha není dostupná. Povol ji v oprávněních prohlížeče.'),
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
  );
}

function status(text) {
  statusEl.textContent = text;
}

function refreshOverlay() {
  realMarkerLayer.clearLayers();
  points.forEach((point, index) => L.marker(point.latlng).bindTooltip(`${index + 1}`).addTo(realMarkerLayer));
  overlayLayer?.remove();
  overlayLayer = null;
  if (customImage && points.length >= 2) overlayLayer = new CalibratedImageOverlay().addTo(leafletMap);
}

function renderPoints() {
  pointsEl.innerHTML = points.map((point, index) => `
    <li>
      #${index + 1}: obrázek ${Math.round(point.image.x)}, ${Math.round(point.image.y)} → ${point.latlng.lat.toFixed(6)}, ${point.latlng.lng.toFixed(6)}
      <button type="button" data-remove-point="${index}">×</button>
    </li>
  `).join('');
}

function renderCustomImage() {
  customMap.innerHTML = '';
  if (!customImage) {
    customMap.innerHTML = '<span>Nahraj obrázek mapy</span>';
    return;
  }
  const img = document.createElement('img');
  img.src = customImage;
  customMap.append(img);
  imageMarkerLayer?.remove();
  imageMarkerLayer = document.createElement('div');
  imageMarkerLayer.className = 'image-markers';
  customMap.append(imageMarkerLayer);
}

function getMaps() {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
}

function setMaps(maps) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(maps));
  renderSavedMaps();
}

function renderSavedMaps() {
  const maps = getMaps();
  savedMapsEl.innerHTML = maps.length ? maps.map((map) => `
    <article>
      <strong>${escapeHtml(map.title)}</strong>
      <small>${map.points.length} bodů</small>
      <p>${escapeHtml(map.description || '')}</p>
      <button type="button" data-load-map="${map.id}">Editovat</button>
      <button type="button" class="secondary" data-delete-map="${map.id}">Smazat</button>
    </article>
  `).join('') : '<p class="hint">Zatím nic uloženého.</p>';
}

function escapeHtml(value) {
  return value.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
}

loginForm.addEventListener('submit', (event) => {
  event.preventDefault();
  localStorage.setItem(SESSION_KEY, document.querySelector('#login-name').value.trim());
  boot();
});

logout.addEventListener('click', () => {
  localStorage.removeItem(SESSION_KEY);
  location.reload();
});

imageInput.addEventListener('change', () => {
  const file = imageInput.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    customImage = reader.result;
    const img = new Image();
    img.onload = () => {
      customImageSize = { width: img.naturalWidth, height: img.naturalHeight };
      points = [];
      renderCustomImage();
      renderPoints();
      refreshOverlay();
      status('Klikni první kalibrační bod ve vlastní mapě.');
    };
    img.src = customImage;
  };
  reader.readAsDataURL(file);
});

customMap.addEventListener('click', (event) => {
  if (!customImage || points.length >= MAX_POINTS) return;
  const rect = customMap.querySelector('img').getBoundingClientRect();
  pendingImagePoint = {
    x: ((event.clientX - rect.left) / rect.width) * customImageSize.width,
    y: ((event.clientY - rect.top) / rect.height) * customImageSize.height,
  };
  status('Teď klikni stejný bod v reálné mapě vpravo.');
});

opacity.addEventListener('input', () => {
  if (overlayLayer?.img) overlayLayer.img.style.opacity = opacity.value;
});

document.querySelector('#clear-points').addEventListener('click', () => {
  points = [];
  pendingImagePoint = null;
  renderPoints();
  refreshOverlay();
  status(customImage ? 'Body smazané. Klikni bod ve vlastní mapě.' : 'Čekám na obrázek.');
});

document.querySelector('#new-map').addEventListener('click', () => {
  editingId = null;
  customImage = null;
  customImageSize = null;
  points = [];
  titleInput.value = '';
  descriptionInput.value = '';
  imageInput.value = '';
  renderCustomImage();
  renderPoints();
  refreshOverlay();
  status('Čekám na obrázek.');
});

document.querySelector('#save-map').addEventListener('click', () => {
  if (!customImage || points.length < 2) {
    status('Pro uložení nahraj obrázek a nastav alespoň 2 kalibrační body.');
    return;
  }
  const maps = getMaps();
  const record = {
    id: editingId || crypto.randomUUID(),
    title: titleInput.value.trim() || 'Nepojmenovaná mapa',
    description: descriptionInput.value.trim(),
    image: customImage,
    imageSize: customImageSize,
    points,
    updatedAt: new Date().toISOString(),
  };
  const index = maps.findIndex((map) => map.id === record.id);
  if (index >= 0) maps[index] = record;
  else maps.unshift(record);
  editingId = record.id;
  setMaps(maps);
  status('Mapa uložená v tomto prohlížeči.');
});

pointsEl.addEventListener('click', (event) => {
  const index = event.target.dataset.removePoint;
  if (index === undefined) return;
  points.splice(Number(index), 1);
  renderPoints();
  refreshOverlay();
});

savedMapsEl.addEventListener('click', (event) => {
  const loadId = event.target.dataset.loadMap;
  const deleteId = event.target.dataset.deleteMap;
  if (deleteId) {
    setMaps(getMaps().filter((map) => map.id !== deleteId));
    return;
  }
  if (!loadId) return;
  const map = getMaps().find((item) => item.id === loadId);
  editingId = map.id;
  customImage = map.image;
  customImageSize = map.imageSize;
  points = map.points.map((point) => ({ ...point, latlng: L.latLng(point.latlng.lat, point.latlng.lng) }));
  titleInput.value = map.title;
  descriptionInput.value = map.description;
  renderCustomImage();
  renderPoints();
  refreshOverlay();
  status('Mapa načtená k editaci.');
});

boot();
