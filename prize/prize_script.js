/* =====================================================================
   UTILITY HELPER FUNCTIONS
===================================================================== */
function escapeHtml(unsafe) {
    return (unsafe || "").toString()
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}
/* =====================================================================
   GLOBAL STATE (Prize: Prize Gallery / Grand Prizes / Custom Prizes / Archive)
===================================================================== */
let pendingLinkTargetKey = null;
let grandPrizesDocs = [];
let grandPrizesLocalNew = [];
let pendingGrandPrizeImageEdits = {};
let pendingGrandPrizeEditKey = null;
/* Staged (not-yet-saved) discrete drop-rate selections for Grand Prizes, keyed by
   the same doc id / _localId used everywhere else in this file. */
let pendingGrandPrizeDropRateEdits = {};
/* Staged (not-yet-saved) "Set Number" quantity edits for Grand Prizes, keyed the
   same way as the other pending-edit maps above. Quantity is the admin-defined
   stock of a Grand Prize still available to be won. */
let pendingGrandPrizeQuantityEdits = {};
/* Guards processExhaustedGrandPrizes() against re-firing the same archive
   transfer twice while its addDoc/deleteDoc pair is still in flight (the
   realtime listener can emit another snapshot before that pair resolves). */
let grandPrizeArchivingKeys = new Set();
/* Suppresses the "reseed a blank slot" structural floor (ensureGrandPrizesMinimum /
   ensureGrandPrizesRateMinimum) during the brief window where a brand-new local
   card is being replaced by its just-saved Firestore doc. Without this guard, the
   local card is removed from the array (bringing the combined list down to 0 for
   an instant) a beat before the real synced doc lands, and the structural floor
   would incorrectly reseed an extra blank card right alongside it. */
let grandPrizeMinimumSuppressCount = 0;

/* Custom Prizes: a fully independent, permanent collection. These entries are never
   touched by the redemption/archiving pipeline -- they persist across draws. */
let customPrizesDocs = [];
let customPrizesLocalNew = [];
let pendingCustomPrizeImageEdits = {};
let pendingCustomPrizeEditKey = null;
let pendingCustomPrizeDropRateEdits = {};
/* Staged (not-yet-saved) QTY edits for Custom Prizes, mirroring the Grand
   Prizes "Set Number" quantity field/behavior. */
let pendingCustomPrizeQuantityEdits = {};
/* Guards processExhaustedCustomPrizes() against re-firing the same archive
   transfer twice while its addDoc/deleteDoc pair is still in flight, exactly
   like grandPrizeArchivingKeys does for Grand Prizes. */
let customPrizeArchivingKeys = new Set();
/* Same purpose as grandPrizeMinimumSuppressCount above, scoped to Custom Prizes'
   own structural floor (ensureCustomPrizesMinimum). */
let customPrizeMinimumSuppressCount = 0;

/* End Prize: a fully independent, permanent collection ("end_prizes") that backs
   the Prize Gallery > END PRIZE tab. This is the fallback gallery -- it is never
   touched by the redemption/archiving pipeline, and deleting a slot here is
   always a true, permanent delete (it never passes through Prize Archive). */
let endPrizesDocs = [];
let endPrizesLocalNew = [];
let pendingEndPrizeImageEdits = {};
let pendingEndPrizeEditKey = null;
/* Same purpose as grandPrizeMinimumSuppressCount above, scoped to End Prizes'
   own structural floor (ensureEndPrizesMinimum). */
let endPrizeMinimumSuppressCount = 0;
let endPrizesListenerStarted = false;

/* Prize Archive: read-only realtime mirror of whatever the live draw pipeline
   writes into the "prize_archive" collection the instant a player interaction
   threshold is hit. The admin panel never adds/edits/deletes entries here. */
let prizeArchiveDocs = [];
let prizeArchiveListenerStarted = false;
let customPrizesListenerStarted = false;

/* The two fixed preset drop-rate targets shown as quick-select buttons for both
   Grand Prizes and No Prize (formerly "Custom Prizes"). Any other value (including
   the reserved 1-5% "Super Grand Price" range) is entered via the custom 0-100%
   manual field that sits alongside these two buttons. */
const GRAND_PRIZE_RATE_OPTIONS = [10, 50, 80];
/* No Prize (Custom Prizes) keeps a single quick-select preset -- 90% -- plus
   the custom 0-100% manual field. Kept separate from GRAND_PRIZE_RATE_OPTIONS
   so Grand Prizes can carry its own four-preset progression without affecting
   this tab. */
const NO_PRIZE_RATE_OPTIONS = [90];

/* =====================================================================
   DYNAMIC STATUS TAG LOGIC
   The text shown inside the status tag overlaid on a Grand Prize's image (and
   inside the Prize Archive card) is derived purely from the saved percentage
   value, using these inclusive ranges:
     1%  - 5%   -> "Super Grand Prize"
     6%  - 10%  -> "Grand Prize"
     11% - 80%  -> "Prize"
     81% - 100% -> "Common Prize"
   Anything else (null/NaN/out of range) falls back to null so callers can
   decide their own default. The "No Prize" tab never calls this -- that
   section intentionally shows no status tag at all.
===================================================================== */
/* =====================================================================
   LIVE DROP-RATE TOTAL
   The Lucky Draw treats every configured `dropRate` as a LITERAL PERCENTAGE of one
   0-100 roll (see resolvePrizeForDraw() in lucky_draw/script.js), not as a relative
   weight. That makes the running total across BOTH pools the number that actually
   decides how the draw behaves:

     total < 100  -> the leftover percentage is a genuine miss (nothing is won)
     total = 100  -> the board is exactly allocated
     total > 100  -> over-committed; the draw scales every rate down proportionally,
                     so the numbers on screen are no longer the real chances

   Grand Prizes and No Prize slots share that one range, so this deliberately sums
   across both tabs — reading either tab in isolation tells you nothing useful.
   Staged (unsaved) edits are included so the readout reflects what you are about to
   save, not only what is already live.
===================================================================== */
function collectConfiguredDropRates() {
    const rates = [];

    grandPrizesRateEditableList().forEach(item => {
        const key = item.id || item._localId;
        const staged = Object.prototype.hasOwnProperty.call(pendingGrandPrizeDropRateEdits, key)
            ? pendingGrandPrizeDropRateEdits[key]
            : (typeof item.dropRate === 'number' ? item.dropRate : null);
        if (typeof staged === 'number' && staged > 0) rates.push(staged);
    });

    customPrizesCombinedList().forEach(item => {
        const key = item.id || item._localId;
        const staged = Object.prototype.hasOwnProperty.call(pendingCustomPrizeDropRateEdits, key)
            ? pendingCustomPrizeDropRateEdits[key]
            : (typeof item.dropRate === 'number' ? item.dropRate : null);
        if (typeof staged === 'number' && staged > 0) rates.push(staged);
    });

    return rates;
}

window.renderDropRateTotal = function() {
    const valueEl = document.getElementById("drop-rate-total-value");
    const fillEl = document.getElementById("drop-rate-total-fill");
    const noteEl = document.getElementById("drop-rate-total-note");
    const boxEl = document.getElementById("drop-rate-total-box");
    if (!valueEl || !fillEl || !noteEl || !boxEl) return;

    const rates = collectConfiguredDropRates();
    const total = rates.reduce((sum, r) => sum + r, 0);
    // Rounded for display only — the draw engine always uses the exact stored values.
    const rounded = Math.round(total * 100) / 100;

    valueEl.innerText = `${rounded}%`;
    fillEl.style.width = `${Math.min(100, total)}%`;

    boxEl.classList.remove("rate-under", "rate-exact", "rate-over");
    if (rates.length === 0) {
        boxEl.classList.add("rate-under");
        noteEl.innerText = "No drop rates configured yet — every spin will resolve as No Prize.";
    } else if (total > 100) {
        boxEl.classList.add("rate-over");
        const scale = (100 / total);
        noteEl.innerText = `Over 100%. The draw will scale every rate down by ×${scale.toFixed(2)} to fit, so the real chances are lower than the numbers shown. Reduce the rates to make them exact.`;
    } else if (total === 100) {
        boxEl.classList.add("rate-exact");
        noteEl.innerText = "Exactly allocated. Every spin lands on a configured prize.";
    } else {
        boxEl.classList.add("rate-under");
        const remainder = Math.round((100 - total) * 100) / 100;
        noteEl.innerText = `${remainder}% of spins will land on nothing (No Prize). Add up to 100% if you want every spin to hit a configured prize.`;
    }
};

function computePrizeStatusTag(dropRate) {
    if (typeof dropRate !== 'number' || isNaN(dropRate)) return null;
    if (dropRate >= 1 && dropRate <= 5) return 'Super Grand Prize';
    if (dropRate >= 6 && dropRate <= 10) return 'Grand Prize';
    if (dropRate >= 11 && dropRate <= 80) return 'Prize';
    if (dropRate >= 81 && dropRate <= 100) return 'Common Prize';
    return null;
}

const GALLERY_PLACEHOLDER_IMG = "data:image/svg+xml;utf8," + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='10' fill='#343454'/><circle cx='22' cy='24' r='6' fill='#555770'/><path d='M8 50 L26 32 L38 44 L48 30 L58 50 Z' fill='#555770'/></svg>"
);


/* Shared fallback gallery/image glyph used inside every 1:1 shadow-box placeholder
   (Latest Prize, Past Prize, Grand Prizes, Edit Elements). Centered via .media-placeholder-icon.
   This is the single global icon mandated for all image placeholder / gallery states. */
const MEDIA_PLACEHOLDER_ICON_SVG = `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M6.205 3h11.59c1.114 0 1.519.116 1.926.334.407.218.727.538.945.945.218.407.334.811.334 1.926v7.51l-4.391-4.053a1.5 1.5 0 0 0-2.265.27l-3.13 4.695-2.303-1.48a1.5 1.5 0 0 0-1.96.298L3.005 18.15A12.98 12.98 0 0 1 3 17.795V6.205c0-1.115.116-1.519.334-1.926.218-.407.538-.727.945-.945C4.686 3.116 5.09 3 6.205 3zm9.477 8.53L21 16.437v1.357c0 1.114-.116 1.519-.334 1.926a2.272 2.272 0 0 1-.945.945c-.407.218-.811.334-1.926.334H6.205c-1.115 0-1.519-.116-1.926-.334a2.305 2.305 0 0 1-.485-.345L8.2 15.067l2.346 1.508a1.5 1.5 0 0 0 2.059-.43l3.077-4.616zM7.988 6C6.878 6 6 6.832 6 7.988 6 9.145 6.879 10 7.988 10 9.121 10 10 9.145 10 7.988 10 6.832 9.121 6 7.988 6z" fill="#ffffff"></path></svg>`;

/* Small "empty archive" glyph -- distinct from the upload/gallery icon above so the
   Prize Archive fallback state reads clearly as "nothing here yet" rather than
   "missing image". */
const ARCHIVE_EMPTY_ICON_SVG = `<svg viewBox="0 0 24 24" width="42" height="42" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 7h16M4 7l1.2 12.1A2 2 0 0 0 7.2 21h9.6a2 2 0 0 0 2-1.9L20 7M4 7l1.6-3.2A1 1 0 0 1 6.5 3h11a1 1 0 0 1 .9.8L20 7" stroke="#A5A6B9" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.5 11h5" stroke="#A5A6B9" stroke-width="1.6" stroke-linecap="round"/></svg>`;

function setLiveStatusIndicator(elId, state) {
    const el = document.getElementById(elId);
    if (!el) return;
    el.classList.remove('state-unsaved', 'state-cancel', 'state-saved', 'state-fade-out');
    if (!state) { el.classList.add('hidden'); el.innerText = ''; return; }
    el.classList.remove('hidden');
    if (state === 'unsaved') {
        el.classList.add('state-unsaved');
        el.innerText = 'UNSAVED';
    } else if (state === 'cancel') {
        el.classList.add('state-cancel');
        el.innerText = 'REMOVED';
    } else if (state === 'saved') {
        el.classList.add('state-saved');
        el.innerText = 'SAVED';
    }
}
/* Marks a field/asset as having unsaved changes. The transient "EDITING" flash
   state has been removed platform-wide -- this now goes straight to the
   persistent "UNSAVED" warning until the section is saved. */
function pulseEditedThenUnsaved(elId) {
    setLiveStatusIndicator(elId, 'unsaved');
}

/* Transitional "SAVED" indicator: the instant an individual Save icon is clicked
   and the write succeeds, flash the vibrant green SAVED pill for exactly 1.5s, then
   smoothly fade it out (hardware-accelerated opacity transition) before hiding it.
   Used globally across Latest Prize, Past Prize, Grand Prizes, Custom Prizes, and
   Edit Elements. */
function flashSavedStatus(elId) {
    const el = document.getElementById(elId);
    if (!el) return;
    setLiveStatusIndicator(elId, 'saved');
    /* Force a reflow so the fade-out transition retriggers reliably even if this
       function is called again on the same element before a prior cycle finished. */
    void el.offsetWidth;
    setTimeout(() => {
        el.classList.add('state-fade-out');
        setTimeout(() => setLiveStatusIndicator(elId, null), 300);
    }, 1500);
}

/* True when a given image URL represents "no real media yet" -- either the gallery
   placeholder icon itself, the initial 1x1 loading GIF, or an empty/missing value. */
function isPlaceholderMediaUrl(url) {
    if (!url) return true;
    if (url === GALLERY_PLACEHOLDER_IMG) return true;
    if (url.indexOf('image/gif;base64') !== -1) return true;
    return false;
}
window.customAlert = function(title, message, type = 'info') {
    return new Promise(resolve => {
        const overlay = document.getElementById("custom-alert-overlay");
        const titleEl = document.getElementById("custom-alert-title");
        const msgEl = document.getElementById("custom-alert-message");
        const btnContainer = document.getElementById("custom-alert-buttons");
        const iconEl = document.getElementById("custom-alert-icon");
        const boxEl = document.getElementById("custom-alert-box");

        boxEl.className = `modal-box-card custom-popup-card popup-${type}`;
        titleEl.innerText = title;
        msgEl.innerText = message;

        let iconSvg = '';
        if(type === 'error') iconSvg = `<svg viewBox="0 0 24 24" width="48" height="48" fill="#FF3B30"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>`;
        else if(type === 'success') iconSvg = `<svg viewBox="0 0 24 24" width="48" height="48" fill="#39FF14"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>`;
        else iconSvg = `<svg viewBox="0 0 24 24" width="48" height="48" fill="#00A8FF"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>`;
        iconEl.innerHTML = iconSvg;

        btnContainer.innerHTML = `<button class="btn btn-secondary-soft btn-sm" id="popup-ok-btn" style="width:100%">UNDERSTOOD</button>`;
        overlay.classList.remove("hidden");

        document.getElementById("popup-ok-btn").onclick = () => {
            overlay.classList.add("hidden");
            resolve();
        };
    });
};

window.customConfirm = function(title, message, type = 'warning') {
    return new Promise(resolve => {
        const overlay = document.getElementById("custom-alert-overlay");
        const titleEl = document.getElementById("custom-alert-title");
        const msgEl = document.getElementById("custom-alert-message");
        const btnContainer = document.getElementById("custom-alert-buttons");
        const iconEl = document.getElementById("custom-alert-icon");
        const boxEl = document.getElementById("custom-alert-box");

        boxEl.className = `modal-box-card custom-popup-card popup-${type}`;
        titleEl.innerText = title;
        msgEl.innerText = message;

        if (type === 'error' || type === 'danger') {
            iconEl.innerHTML = `<svg viewBox="0 0 24 24" width="48" height="48" fill="#FF3B30"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>`;
        } else if (type === 'success') {
            iconEl.innerHTML = `<svg viewBox="0 0 24 24" width="48" height="48" fill="#39FF14"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>`;
        } else if (type === 'info') {
            iconEl.innerHTML = `<svg viewBox="0 0 24 24" width="48" height="48" fill="#00A8FF"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>`;
        } else {
            iconEl.innerHTML = `<svg viewBox="0 0 24 24" width="48" height="48" fill="#FFD200"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>`;
        }

        btnContainer.innerHTML = `
            <button class="btn btn-secondary-soft btn-sm" id="popup-cancel-btn">CANCEL</button>
            <button class="btn btn-action-green btn-sm" id="popup-confirm-btn">CONFIRM</button>
        `;
        overlay.classList.remove("hidden");

        document.getElementById("popup-cancel-btn").onclick = () => {
            overlay.classList.add("hidden");
            resolve(false);
        };
        document.getElementById("popup-confirm-btn").onclick = () => {
            overlay.classList.add("hidden");
            resolve(true);
        };
    });
};
window.openLinkInput = function(targetKey) {
    pendingLinkTargetKey = targetKey;
    document.getElementById("link-input-field").value = "";
    document.getElementById("link-input-overlay").classList.remove("hidden");
    document.getElementById("link-input-field").focus();
};
window.cancelLinkInput = function() {
    document.getElementById("link-input-overlay").classList.add("hidden");
    pendingLinkTargetKey = null;
};
/* Normalizes a pasted GitHub "blob" page URL (the link you get from browsing a
   file on github.com) into its direct raw.githubusercontent.com equivalent, so
   the Link operation works perfectly whether the admin pastes a raw link or
   a regular GitHub file page link. Any non-GitHub URL passes through untouched. */
function normalizeGithubImageUrl(url) {
    if (!url) return url;
    if (/^https?:\/\/github\.com\/.+\/blob\/.+/i.test(url)) {
        return url.replace(/^https?:\/\/github\.com\//i, "https://raw.githubusercontent.com/").replace("/blob/", "/");
    }
    return url;
}

window.confirmLinkInput = async function() {
    const val = normalizeGithubImageUrl(document.getElementById("link-input-field").value.trim());
    document.getElementById("link-input-overlay").classList.add("hidden");
    const targetKey = pendingLinkTargetKey;
    pendingLinkTargetKey = null;

    if (!val || !/^https?:\/\//i.test(val)) {
        await customAlert("Invalid Link", "Please paste a valid direct image URL starting with http/https.", "error");
        return;
    }

    if (typeof targetKey === 'string' && targetKey.startsWith('grandprize-edit-')) {
        const key = targetKey.replace('grandprize-edit-', '');
        pendingGrandPrizeImageEdits[key] = val;
        buildGrandPrizesListUI();
        buildGrandPrizesRateListUI();
        pulseEditedThenUnsaved(`grandprize-status-${key}`);
        await customAlert("Link Applied", "Image link staged for this prize. Click its SAVE icon to publish.", "success");
    } else if (typeof targetKey === 'string' && targetKey.startsWith('customprize-edit-')) {
        const key = targetKey.replace('customprize-edit-', '');
        pendingCustomPrizeImageEdits[key] = val;
        buildCustomPrizesListUI();
        pulseEditedThenUnsaved(`customprize-status-${key}`);
        await customAlert("Link Applied", "Image link staged for this prize. Click its SAVE icon to publish.", "success");
    } else if (typeof targetKey === 'string' && targetKey.startsWith('endprize-edit-')) {
        const key = targetKey.replace('endprize-edit-', '');
        pendingEndPrizeImageEdits[key] = val;
        buildEndPrizesListUI();
        pulseEditedThenUnsaved(`endprize-status-${key}`);
        await customAlert("Link Applied", "Image link staged for this prize. Click its SAVE icon to publish.", "success");
    }
};
window.switchGrandPrizesPrimaryTab = function(tabName) {
    document.querySelectorAll("#grandprizes-primary-tabs .segment-btn").forEach(btn => btn.classList.remove("active"));
    const idx = { gallery: 0, new: 1 }[tabName];
    document.querySelectorAll("#grandprizes-primary-tabs .segment-btn")[idx].classList.add("active");
    document.getElementById("grandprizes-view-gallery").classList.toggle("active", tabName === 'gallery');
    document.getElementById("grandprizes-view-gallery").classList.toggle("hidden", tabName !== 'gallery');
    document.getElementById("grandprizes-view-new").classList.toggle("active", tabName === 'new');
    document.getElementById("grandprizes-view-new").classList.toggle("hidden", tabName !== 'new');
}

/* Prize Gallery sub-tabs: CURRENT PRIZE (the existing archivable "grand_prizes"
   gallery, broadcast live while it has active entries) vs END PRIZE (the
   permanent, non-archivable "end_prizes" fallback gallery). Mirrors the same
   segmented-tab pattern used by the Prize Rate inner tabs below. */
window.switchGalleryPrimaryTab = function(tabName) {
    document.querySelectorAll("#gallery-primary-tabs .segment-btn").forEach(btn => btn.classList.remove("active"));
    const idx = { current: 0, end: 1 }[tabName];
    document.querySelectorAll("#gallery-primary-tabs .segment-btn")[idx].classList.add("active");
    document.getElementById("gallery-view-current").classList.toggle("active", tabName === 'current');
    document.getElementById("gallery-view-current").classList.toggle("hidden", tabName !== 'current');
    document.getElementById("gallery-view-end").classList.toggle("active", tabName === 'end');
    document.getElementById("gallery-view-end").classList.toggle("hidden", tabName !== 'end');
}

/* Prize Pool sub-tabs: PRIZE RATE (Grand/Custom split) vs PRIZE ARCHIVE (read-only
   realtime log). The Archive stream is only ever attached the first time an admin
   actually opens that tab, so idle sessions never pay for an unused listener. */
window.switchGrandPrizesSubTab = function(tabName) {
    document.querySelectorAll("#grandprizes-sub-tabs .segment-btn").forEach(btn => btn.classList.remove("active"));
    const idx = { rate: 0, archive: 1 }[tabName];
    document.querySelectorAll("#grandprizes-sub-tabs .segment-btn")[idx].classList.add("active");
    document.getElementById("prizerate-panel-rate").classList.toggle("hidden", tabName !== 'rate');
    document.getElementById("prizerate-panel-archive").classList.toggle("hidden", tabName !== 'archive');
    if (tabName === 'archive') initializeRealtimePrizeArchiveStream();
}

/* Prize Rate inner split: GRAND PRIZES (discrete preset % buttons, backed by the
   same "grand_prizes" collection that powers the Prize Gallery / live carousel)
   vs CUSTOM PRIZES (its own permanent, manually-tunable collection). */
window.switchPrizeRateInnerTab = function(tabName) {
    document.querySelectorAll("#prizerate-inner-tabs .segment-btn").forEach(btn => btn.classList.remove("active"));
    const idx = { grand: 0, custom: 1 }[tabName];
    document.querySelectorAll("#prizerate-inner-tabs .segment-btn")[idx].classList.add("active");
    document.getElementById("prizerate-view-grand").classList.toggle("active", tabName === 'grand');
    document.getElementById("prizerate-view-grand").classList.toggle("hidden", tabName !== 'grand');
    document.getElementById("prizerate-view-custom").classList.toggle("active", tabName === 'custom');
    document.getElementById("prizerate-view-custom").classList.toggle("hidden", tabName !== 'custom');
    if (tabName === 'custom') {
        /* Render immediately so any already-cached/staged state shows right away
           instead of waiting on the first onSnapshot fire; the realtime stream
           below still attaches/keeps everything in sync afterward. */
        buildCustomPrizesListUI();
        initializeRealtimeCustomPrizesStream();
    }
}

/* =====================================================================
   GRAND PRIZES DASHBOARD — Firestore-backed infinite carousel source
   Collection: "grand_prizes" — each doc: { imageUrl, createdAt, dropRate }
   The Lucky Draw frontend listens to this same collection to drive its
   HighEndCarousel: 1 image = static frame, 2+ images = infinite loop.
   `dropRate` (one of GRAND_PRIZE_RATE_OPTIONS) is configured from the Prize
   Rate > Grand Prizes tab and does not affect the Prize Gallery view itself.
===================================================================== */
function initializeRealtimeGrandPrizesStream() {
    if (!window.FirebaseBridge) return;
    const { db, collection, query, onSnapshot } = window.FirebaseBridge;

    onSnapshot(query(collection(db, "grand_prizes")), (querySnapshot) => {
        grandPrizesDocs = [];
        querySnapshot.forEach(docSnap => { grandPrizesDocs.push({ id: docSnap.id, ...docSnap.data() }); });
        grandPrizesDocs.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        buildGrandPrizesListUI();
        buildGrandPrizesRateListUI();
        processExhaustedGrandPrizes();
    });
}

function grandPrizesCombinedList() {
    return [...grandPrizesDocs, ...grandPrizesLocalNew];
}

/* Legacy safety filter: any older "grand_prizes" doc still carrying the
   syncedFromCustomPrize flag (from before No Prize slots were decoupled from
   the gallery) stays out of the Prize Rate > Grand Prizes admin/config view.
   New No Prize saves never set this flag, so this only matters for pre-
   existing data; the Prize Gallery view keeps using the unfiltered list above. */
function grandPrizesRateEditableList() {
    return grandPrizesCombinedList().filter(item => !item.syncedFromCustomPrize);
}

/* Structural default-state guardrail: the Prize Gallery / Grand Prizes list can
   never render completely empty. If Firestore and the local staging array both
   come back empty (e.g. right after the very last real prize was deleted), a
   single blank local card is silently reseeded so exactly 1 slot always exists. */
function ensureGrandPrizesMinimum() {
    /* BUGFIX: this used to silently push a brand-new blank local card the
       instant the combined list was empty (e.g. on first load before the
       realtime listener had returned data, or for a beat right after a save).
       That auto-reseeded card was indistinguishable from a real slot and never
       got cleaned up once real data arrived, which is exactly what caused the
       "extra blank card" bug on the No Prize / Prize Rate tabs. Empty state is
       now simply empty state -- a new slot is only ever created explicitly via
       the "ADD MORE" button. */
    return;
}

/* Same structural floor as ensureGrandPrizesMinimum(), but scoped to the
   admin-editable (non-custom-prize-synced) list so the Prize Rate > Grand
   Prizes tab always keeps at least one configurable slot even when every
   entry in "grand_prizes" happens to be a synced Custom Prize right now. */
function ensureGrandPrizesRateMinimum() {
    /* BUGFIX: see ensureGrandPrizesMinimum() above -- same auto-reseed removed
       for the same reason. A new slot is only ever created via "ADD MORE". */
    return;
}

window.buildGrandPrizesListUI = function() {
    const container = document.getElementById("grand-prizes-list-container");
    if (!container) return;
    ensureGrandPrizesMinimum();
    const combined = grandPrizesCombinedList();

    let html = "";
    combined.forEach((item) => {
        const key = item.id || item._localId;
        const safeKey = escapeHtml(key);
        const imgUrl = pendingGrandPrizeImageEdits[key] || item.imageUrl || GALLERY_PLACEHOLDER_IMG;
        const isEmptyMedia = isPlaceholderMediaUrl(imgUrl);
        html += `
        <div class="past-prize-row grand-prize-row">
            <div class="past-prize-thumb-col">
                <div class="media-thumb-wrap gallery-thumb-wrap">
                    <div class="media-shadow-box${isEmptyMedia ? ' is-empty' : ''}">
                        <img src="${imgUrl}" alt="Grand Prize" class="img-loading" onload="this.classList.remove('img-loading')">
                        <div class="media-placeholder-icon">${MEDIA_PLACEHOLDER_ICON_SVG}</div>
                    </div>
                </div>
            </div>
            <div class="past-prize-fields-col grand-prize-fields-col">
                <div class="mini-live-tag-row gallery-live-tag-inline">
                    <span class="thumb-live-badge mini-live-tag">LIVE PREVIEW <span class="live-dot"></span></span>
                    <span id="grandprize-status-${safeKey}" class="state-indicator hidden"></span>
                </div>
                <div class="past-prize-icon-row grand-prize-icon-row">
                    <button class="icon-mini-btn upload-mini" title="Upload New Image" onclick="editGrandPrizeImageUpload('${safeKey}')"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.36 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/></svg></button>
                    <button class="icon-mini-btn link-mini" title="Paste Image Link" onclick="openLinkInput('grandprize-edit-${safeKey}')"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg></button>
                    <button class="icon-mini-btn remove-mini" title="Delete" onclick="deleteGrandPrizeItem('${safeKey}')"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>
                    <button class="icon-mini-btn save-mini" title="Save" onclick="saveGrandPrizeItem('${safeKey}', true)"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"/></svg></button>
                </div>
                <div class="upload-progress-container hidden" data-progress-key="grandprize-${safeKey}">
                    <div class="progress-bar-track"><div class="progress-bar-fill" data-progress-fill></div></div>
                    <div class="progress-stats">
                        <span data-progress-percent>0%</span>
                        <span data-progress-speed>0 KB/s</span>
                    </div>
                </div>
            </div>
        </div>`;
    });
    container.innerHTML = html;
};

/* =====================================================================
   PRIZE RATE > GRAND PRIZES — same underlying "grand_prizes" collection as
   the Prize Gallery above, rendered with the six discrete drop-rate preset
   buttons instead of the plain image-only card.
===================================================================== */
window.buildGrandPrizesRateListUI = function() {
    const container = document.getElementById("grand-prizes-rate-list-container");
    if (!container) return;
    ensureGrandPrizesRateMinimum();
    const combined = grandPrizesRateEditableList();

    let html = "";
    combined.forEach((item) => {
        const key = item.id || item._localId;
        const safeKey = escapeHtml(key);
        const imgUrl = pendingGrandPrizeImageEdits[key] || item.imageUrl || GALLERY_PLACEHOLDER_IMG;
        const isEmptyMedia = isPlaceholderMediaUrl(imgUrl);
        const currentRate = Object.prototype.hasOwnProperty.call(pendingGrandPrizeDropRateEdits, key)
            ? pendingGrandPrizeDropRateEdits[key]
            : (typeof item.dropRate === 'number' ? item.dropRate : null);
        const currentQuantity = Object.prototype.hasOwnProperty.call(pendingGrandPrizeQuantityEdits, key)
            ? pendingGrandPrizeQuantityEdits[key]
            : (typeof item.quantity === 'number' ? item.quantity : 1);

        let rateButtonsHtml = "";
        GRAND_PRIZE_RATE_OPTIONS.forEach(rate => {
            const isActive = currentRate === rate;
            rateButtonsHtml += `<button type="button" class="rate-btn${isActive ? ' active' : ''}" onclick="setGrandPrizeDropRate('${safeKey}', ${rate})">${rate}%</button>`;
        });
        const isCustomRateActive = currentRate !== null && !GRAND_PRIZE_RATE_OPTIONS.includes(currentRate);
        const overlayTagText = computePrizeStatusTag(currentRate);

        html += `
        <div class="past-prize-row grand-prize-row prize-slot-card" data-row-key="${safeKey}">
            <div class="prize-slot-top-row">
                <div class="past-prize-thumb-col">
                    <div class="media-thumb-wrap">
                        <div class="media-shadow-box${isEmptyMedia ? ' is-empty' : ''}">
                            <img src="${imgUrl}" alt="Grand Prize" class="img-loading" onload="this.classList.remove('img-loading')">
                            <div class="media-placeholder-icon">${MEDIA_PLACEHOLDER_ICON_SVG}</div>
                        </div>
                        <span id="grandprizerate-status-${safeKey}" class="state-indicator hidden thumb-status-badge-overlay"></span>
                        ${overlayTagText ? `<span class="thumb-type-badge-overlay">${escapeHtml(overlayTagText)}</span>` : ''}
                    </div>
                </div>
                <div class="past-prize-fields-col grand-prize-fields-col">
                    <div class="manual-rate-input-wrap quantity-input-wrap">
                        <input type="number" inputmode="numeric" pattern="[0-9]*" min="0" step="1" value="${escapeHtml(currentQuantity)}" title="Set Number of Prizes" oninput="setGrandPrizeQuantityValue('${safeKey}', this.value, this)">
                        <span class="pct-suffix">QTY</span>
                    </div>
                    <div class="past-prize-icon-row grand-prize-icon-row three-col">
                        <button class="icon-mini-btn upload-mini" title="Upload New Image" onclick="editGrandPrizeImageUpload('${safeKey}')"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.36 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/></svg></button>
                        <button class="icon-mini-btn link-mini" title="Paste Image Link" onclick="openLinkInput('grandprize-edit-${safeKey}')"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg></button>
                        <button class="icon-mini-btn remove-mini" title="Reset Image" onclick="clearGrandPrizeImage('${safeKey}')"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>
                    </div>
                    <div class="upload-progress-container hidden" data-progress-key="grandprize-${safeKey}">
                        <div class="progress-bar-track"><div class="progress-bar-fill" data-progress-fill></div></div>
                        <div class="progress-stats">
                            <span data-progress-percent>0%</span>
                            <span data-progress-speed>0 KB/s</span>
                        </div>
                    </div>
                </div>
            </div>
            <div class="rate-btn-grid four-plus-custom">
                ${rateButtonsHtml}
                <div class="manual-rate-input-wrap custom-rate-slot${isCustomRateActive ? ' active-custom' : ''}">
                    <input type="number" inputmode="numeric" pattern="[0-9]*" min="1" max="100" maxlength="3" step="1" placeholder="1-100" value="${isCustomRateActive ? escapeHtml(currentRate) : ''}" oninput="if(this.value.length>3)this.value=this.value.slice(0,3); setGrandPrizeDropRate('${safeKey}', this.value === '' ? null : parseInt(this.value, 10), this)">
                    <span class="pct-suffix">%</span>
                </div>
            </div>
            <div class="dual-btn-row card-action-row card-action-row-lg">
                <button class="btn btn-danger-action btn-sm" onclick="deleteGrandPrizeItem('${safeKey}')">REMOVE</button>
                <button class="btn btn-action-green btn-sm" onclick="saveGrandPrizeItem('${safeKey}')">SAVE</button>
            </div>
        </div>`;
    });
    container.innerHTML = html;
    renderDropRateTotal();
};

/* Surgical in-row refresh used by setGrandPrizeDropRate() below. Rebuilding the
   entire "grand-prizes-rate-list-container" innerHTML on every keystroke (the
   previous behavior) replaces the exact DOM input node the admin is actively
   typing into, which is what caused the mobile soft keyboard to dismiss after
   a single character. This instead patches only the preset-button highlight,
   the custom-slot active state, and the overlaid status tag for the one row
   that changed, leaving every input element (and its focus/caret) untouched. */
function updateGrandPrizeRateRowUI(key) {
    const safeKey = escapeHtml(key);
    const row = document.querySelector(`.grand-prize-row[data-row-key="${safeKey}"]`);
    if (!row) { buildGrandPrizesRateListUI(); return; }

    const currentRate = Object.prototype.hasOwnProperty.call(pendingGrandPrizeDropRateEdits, key)
        ? pendingGrandPrizeDropRateEdits[key]
        : null;

    const presetButtons = row.querySelectorAll('.rate-btn-grid.four-plus-custom > .rate-btn');
    presetButtons.forEach((btn, idx) => {
        btn.classList.toggle('active', currentRate === GRAND_PRIZE_RATE_OPTIONS[idx]);
    });

    const isCustomRateActive = currentRate !== null && !GRAND_PRIZE_RATE_OPTIONS.includes(currentRate);
    const customSlot = row.querySelector('.custom-rate-slot');
    if (customSlot) customSlot.classList.toggle('active-custom', isCustomRateActive);

    const thumbWrap = row.querySelector('.media-thumb-wrap');
    if (thumbWrap) {
        const overlayTagText = computePrizeStatusTag(currentRate);
        let badgeEl = thumbWrap.querySelector('.thumb-type-badge-overlay');
        if (overlayTagText) {
            if (!badgeEl) {
                badgeEl = document.createElement('span');
                badgeEl.className = 'thumb-type-badge-overlay';
                thumbWrap.appendChild(badgeEl);
            }
            badgeEl.innerText = overlayTagText;
        } else if (badgeEl) {
            badgeEl.remove();
        }
    }
}

window.setGrandPrizeDropRate = function(key, rate, inputEl) {
    if (rate === null || rate === undefined || isNaN(rate)) {
        pendingGrandPrizeDropRateEdits[key] = null;
    } else {
        let num = parseInt(rate, 10);
        if (isNaN(num)) num = 1;
        /* Custom percentage range is strictly 1-100 -- 0 is never a valid,
           savable value, so it's floored to 1 the moment it's typed. */
        num = Math.max(1, Math.min(100, num));
        pendingGrandPrizeDropRateEdits[key] = num;
        if (inputEl && inputEl.value !== String(num)) inputEl.value = num;
    }
    updateGrandPrizeRateRowUI(key);
    renderDropRateTotal();
    pulseEditedThenUnsaved(`grandprizerate-status-${key}`);
};

/* Small trash icon inside the image block: resets/removes ONLY the staged or
   saved image asset for this slot, leaving quantity, drop-rate, and every other
   field on the card completely untouched. This is distinct from the big red
   REMOVE button below, which clears the entire slot/configuration. */
window.clearGrandPrizeImage = function(key) {
    pendingGrandPrizeImageEdits[key] = "";
    buildGrandPrizesListUI();
    buildGrandPrizesRateListUI();
    pulseEditedThenUnsaved(`grandprizerate-status-${key}`);
};

/* Volume Control: stages the "Set Number" quantity edit for a Grand Prize.
   Clamped to a non-negative integer and, just like the Custom Prize % field,
   the input element itself is corrected in place if an out-of-range value
   was typed, so what's on screen always matches the enforced value. */
window.setGrandPrizeQuantityValue = function(key, rawValue, inputEl) {
    let num = parseInt(rawValue, 10);
    if (isNaN(num) || num < 0) num = 0;
    pendingGrandPrizeQuantityEdits[key] = num;
    if (inputEl && inputEl.value !== String(num)) inputEl.value = num;
    pulseEditedThenUnsaved(`grandprizerate-status-${key}`);
};

window.addNewGrandPrizeCard = async function() {
    const confirmed = await customConfirm("Add New Prize", "Add another blank Grand Prize entry card?", "info");
    if (!confirmed) return;
    /* Always start clean: clear any stale "which card is the file-picker targeting"
       reference so a fresh card never inherits artifacts from a prior in-progress edit. */
    pendingGrandPrizeEditKey = null;
    const newLocalId = `new-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    grandPrizesLocalNew.push({ _localId: newLocalId, imageUrl: "", quantity: 1 });
    buildGrandPrizesListUI();
    buildGrandPrizesRateListUI();
    pulseEditedThenUnsaved(`grandprize-status-${newLocalId}`);
};

window.handleGrandPrizeFileChosen = function(input) {
    handleCloudinaryUpload(input, 'grandprize');
};

window.editGrandPrizeImageUpload = function(key) {
    pendingGrandPrizeEditKey = key;
    const sharedInput = document.getElementById("grand-prize-file-shared");
    if (!sharedInput) return;
    sharedInput.value = ""; /* reset so choosing the same file again for a different card still fires 'change' */
    sharedInput.click();
};

window.saveGrandPrizeItem = async function(key, skipRateValidation) {
    if (!window.FirebaseBridge) return;
    const { db, doc, collection, addDoc, updateDoc } = window.FirebaseBridge;
    const combined = grandPrizesCombinedList();
    const item = combined.find(x => (x.id || x._localId) === key);
    if (!item) return;

    const finalImageUrl = pendingGrandPrizeImageEdits[key] || item.imageUrl;
    if (!finalImageUrl) {
        await customAlert("Missing Image", "Upload or paste a link before saving this prize.", "error");
        return;
    }
    const finalDropRate = Object.prototype.hasOwnProperty.call(pendingGrandPrizeDropRateEdits, key)
        ? pendingGrandPrizeDropRateEdits[key]
        : (typeof item.dropRate === 'number' ? item.dropRate : null);

    /* Mandatory drop-rate criteria: a save can never go through without one of the
       six discrete preset percentages selected. Blocked before any state mutation
       or Firestore write is attempted.
       EXCEPTION: Prize Gallery > CURRENT PRIZE saves are instant by design -- that
       tab has no percentage/quantity allocation UI at all, so skipRateValidation
       is passed as true and this whole gate is bypassed. The Prize Rate > Grand
       Prizes tab (skipRateValidation left undefined/false) keeps enforcing it. */
    if (!skipRateValidation) {
        if (finalDropRate === null || typeof finalDropRate !== 'number' || isNaN(finalDropRate) || finalDropRate < 1 || finalDropRate > 100) {
            await customAlert("Submission Failed", "Please select a preset percentage or enter a valid custom percentage between 1\u2013100 before saving.", "error");
            return;
        }
    }

    const finalQuantity = Object.prototype.hasOwnProperty.call(pendingGrandPrizeQuantityEdits, key)
        ? pendingGrandPrizeQuantityEdits[key]
        : (typeof item.quantity === 'number' ? item.quantity : 1);

    try {
        if (item.id) {
            const payload = { imageUrl: finalImageUrl, quantity: finalQuantity, lastModified: new Date().getTime() };
            if (finalDropRate !== null) payload.dropRate = finalDropRate;
            await updateDoc(doc(db, "grand_prizes", item.id), payload);
            delete pendingGrandPrizeImageEdits[key];
            delete pendingGrandPrizeDropRateEdits[key];
            delete pendingGrandPrizeQuantityEdits[key];
            flashSavedStatus(`grandprize-status-${key}`);
            flashSavedStatus(`grandprizerate-status-${key}`);
        } else {
            /* THE DUPLICATE-CARD FIX: Firestore's onSnapshot listener can fire an
               optimistic local update the instant addDoc() is issued -- often before
               this function's own "await" even resolves. If the temporary local card
               is still sitting in grandPrizesLocalNew when that snapshot fires, the
               combined list briefly contains BOTH the old blank/local card and the
               newly-synced server card, rendering as a duplicate underneath it.
               Clearing the local card and re-rendering immediately -- before the
               write is sent -- closes that race window entirely, so saving always
               cleanly replaces the local card with the synced one and never spawns
               a trailing duplicate.
               grandPrizeMinimumSuppressCount guards the OTHER side of this same
               window: with the local card already removed, the combined list can
               read as momentarily empty before the synced doc lands, which would
               otherwise cause the structural floor to reseed its own blank card
               right alongside the real one. */
            grandPrizeMinimumSuppressCount++;
            try {
                grandPrizesLocalNew = grandPrizesLocalNew.filter(x => x._localId !== item._localId);
                delete pendingGrandPrizeImageEdits[key];
                delete pendingGrandPrizeDropRateEdits[key];
                delete pendingGrandPrizeQuantityEdits[key];
                buildGrandPrizesListUI();
                buildGrandPrizesRateListUI();
                const payload = { imageUrl: finalImageUrl, quantity: finalQuantity, createdAt: new Date().getTime() };
                if (finalDropRate !== null) payload.dropRate = finalDropRate;
                await addDoc(collection(db, "grand_prizes"), payload);
            } finally {
                grandPrizeMinimumSuppressCount--;
            }
        }
        await customAlert("Saved", skipRateValidation ? "Prize saved to the gallery." : "Grand prize synced. It will now appear in the live carousel.", "success");
    } catch (err) { await customAlert("Error", "Failed to sync this grand prize.", "error"); }
};

window.deleteGrandPrizeItem = async function(key) {
    const combined = grandPrizesCombinedList();
    const item = combined.find(x => (x.id || x._localId) === key);
    if (!item) return;

    const confirmed = await customConfirm("Remove Prize", "Are you sure you want to remove this prize entry?", "danger");
    if (!confirmed) return;

    delete pendingGrandPrizeImageEdits[key];
    delete pendingGrandPrizeDropRateEdits[key];
    delete pendingGrandPrizeQuantityEdits[key];

    if (!item.id) {
        /* Removing a not-yet-saved local card simply removes it -- the list is
           allowed to render fully empty now; a new blank slot is only ever
           created again via the "ADD MORE" button. */
        grandPrizesLocalNew = grandPrizesLocalNew.filter(x => x._localId !== item._localId);
        buildGrandPrizesListUI();
        buildGrandPrizesRateListUI();
        return;
    }

    if (!window.FirebaseBridge) return;
    const { db, doc, deleteDoc } = window.FirebaseBridge;
    try {
        await deleteDoc(doc(db, "grand_prizes", item.id));
        await customAlert("Deleted", "Grand prize removed.", "success");
    } catch (err) { await customAlert("Error", "Failed to delete this grand prize.", "error"); }
};

/* =====================================================================
   GRAND PRIZES > VOLUME CONTROL + AUTO-ARCHIVE ON DISTRIBUTION
   Each Grand Prize now carries an admin-defined `quantity` (the "Set Number"
   of copies still available to be won, edited via the QTY field above and
   persisted by the normal Save icon). The gold star DISTRIBUTE icon is the
   explicit "this prize was just selected/handed out" action -- it decrements
   quantity by 1 directly in Firestore. The realtime grand_prizes listener
   then calls processExhaustedGrandPrizes() on every snapshot, and the
   instant a prize's quantity reaches 0 it is copied into "prize_archive"
   and removed from "grand_prizes" -- the "winners are moved into the Prize
   Archive upon selection/distribution" routine.
===================================================================== */
function processExhaustedGrandPrizes() {
    if (!window.FirebaseBridge) return;
    const { db, doc, collection, runTransaction } = window.FirebaseBridge;

    grandPrizesDocs.forEach((item) => {
        if (!item.id) return;
        if (typeof item.quantity !== 'number' || item.quantity > 0) return;
        if (grandPrizeArchivingKeys.has(item.id)) return; /* transfer already in flight for this doc */
        grandPrizeArchivingKeys.add(item.id);

        (async () => {
            try {
                /* Atomic archive+delete in a single transaction. The Lucky Draw runs its
                   own archive pipeline on the same docs, so this must (a) re-verify the
                   source doc still exists inside the transaction — if the draw already
                   archived it, exists() is false and we do nothing — and (b) never leave
                   the old addDoc-succeeded/delete-failed half-state that produced
                   duplicate prize_archive entries on the next snapshot. */
                const activeRef = doc(db, "grand_prizes", item.id);
                const archiveRef = doc(collection(db, "prize_archive"));
                await runTransaction(db, async (transaction) => {
                    const snap = await transaction.get(activeRef);
                    if (!snap.exists()) return; /* already archived by the Lucky Draw or another tab */
                    const data = snap.data();
                    if (typeof data.quantity !== 'number' || data.quantity > 0) return; /* restocked meanwhile */
                    transaction.set(archiveRef, {
                        name: "Grand Prize",
                        imageUrl: data.imageUrl || "",
                        dropRate: typeof data.dropRate === 'number' ? data.dropRate : null,
                        quantity: 1,
                        outcomeType: "Grand Prize",
                        origin: "grand_prizes",
                        archivedAt: new Date().getTime()
                    });
                    transaction.delete(activeRef);
                });
                console.log('[Lifecycle] Prize depleted and moved to Archive');
            } catch (err) {
                /* Release the guard on failure so the next snapshot gets another
                   chance to archive it instead of being permanently blocked. */
            } finally {
                grandPrizeArchivingKeys.delete(item.id);
            }
        })();
    });
}

/* NOTE: the manual "Mark as Distributed" star action has been removed from the
   UI (redundant control). Quantity is still fully live -- the Firestore
   `quantity` field on each grand_prizes doc is watched by the realtime
   listener above, and processExhaustedGrandPrizes() below still auto-archives
   any prize the instant its quantity is written down to 0 by the connected
   Lucky Draw app or by editing the QTY field here and hitting Save. */

/* =====================================================================
   PRIZE GALLERY > END PRIZE — fully independent, permanent collection
   ("end_prizes"). This is the fallback gallery: it holds no drop-rate or
   quantity fields (saves are instant, exactly like CURRENT PRIZE), it is
   never touched by the win/archive pipeline, and deleting a slot here is
   always a true, permanent Firestore delete -- it never passes through
   "prize_archive". Kept as its own collection/state entirely separate from
   "grand_prizes" so CURRENT PRIZE and END PRIZE never collide.
===================================================================== */
function initializeRealtimeEndPrizesStream() {
    if (endPrizesListenerStarted) return;
    endPrizesListenerStarted = true;
    if (!window.FirebaseBridge) return;
    const { db, collection, query, onSnapshot } = window.FirebaseBridge;

    onSnapshot(query(collection(db, "end_prizes")), (querySnapshot) => {
        endPrizesDocs = [];
        querySnapshot.forEach(docSnap => { endPrizesDocs.push({ id: docSnap.id, ...docSnap.data() }); });
        endPrizesDocs.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        buildEndPrizesListUI();
    });
}

function endPrizesCombinedList() {
    return [...endPrizesDocs, ...endPrizesLocalNew];
}

/* BUGFIX: see ensureGrandPrizesMinimum() above -- auto-reseed removed for the
   same reason. A new slot is only ever created via "ADD MORE". */
function ensureEndPrizesMinimum() {
    return;
}

window.buildEndPrizesListUI = function() {
    const container = document.getElementById("end-prizes-list-container");
    if (!container) return;
    ensureEndPrizesMinimum();
    const combined = endPrizesCombinedList();

    let html = "";
    combined.forEach((item) => {
        const key = item.id || item._localId;
        const safeKey = escapeHtml(key);
        const imgUrl = pendingEndPrizeImageEdits[key] || item.imageUrl || GALLERY_PLACEHOLDER_IMG;
        const isEmptyMedia = isPlaceholderMediaUrl(imgUrl);
        html += `
        <div class="past-prize-row grand-prize-row">
            <div class="past-prize-thumb-col">
                <div class="media-thumb-wrap gallery-thumb-wrap">
                    <div class="media-shadow-box${isEmptyMedia ? ' is-empty' : ''}">
                        <img src="${imgUrl}" alt="End Prize" class="img-loading" onload="this.classList.remove('img-loading')">
                        <div class="media-placeholder-icon">${MEDIA_PLACEHOLDER_ICON_SVG}</div>
                    </div>
                </div>
            </div>
            <div class="past-prize-fields-col grand-prize-fields-col">
                <div class="mini-live-tag-row gallery-live-tag-inline">
                    <span class="thumb-live-badge mini-live-tag permanent-badge">PERMANENT</span>
                    <span id="endprize-status-${safeKey}" class="state-indicator hidden"></span>
                </div>
                <div class="past-prize-icon-row grand-prize-icon-row">
                    <button class="icon-mini-btn upload-mini" title="Upload New Image" onclick="editEndPrizeImageUpload('${safeKey}')"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.36 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/></svg></button>
                    <button class="icon-mini-btn link-mini" title="Paste Image Link" onclick="openLinkInput('endprize-edit-${safeKey}')"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg></button>
                    <button class="icon-mini-btn remove-mini" title="Delete Permanently" onclick="deleteEndPrizeItem('${safeKey}')"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>
                    <button class="icon-mini-btn save-mini" title="Save" onclick="saveEndPrizeItem('${safeKey}')"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"/></svg></button>
                </div>
                <div class="upload-progress-container hidden" data-progress-key="endprize-${safeKey}">
                    <div class="progress-bar-track"><div class="progress-bar-fill" data-progress-fill></div></div>
                    <div class="progress-stats">
                        <span data-progress-percent>0%</span>
                        <span data-progress-speed>0 KB/s</span>
                    </div>
                </div>
            </div>
        </div>`;
    });
    container.innerHTML = html;
};

window.addNewEndPrizeCard = async function() {
    const confirmed = await customConfirm("Add New Prize", "Add another blank End Prize entry card?", "info");
    if (!confirmed) return;
    pendingEndPrizeEditKey = null;
    const newLocalId = `new-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    endPrizesLocalNew.push({ _localId: newLocalId, imageUrl: "" });
    buildEndPrizesListUI();
    pulseEditedThenUnsaved(`endprize-status-${newLocalId}`);
};

window.handleEndPrizeFileChosen = function(input) {
    handleCloudinaryUpload(input, 'endprize');
};

window.editEndPrizeImageUpload = function(key) {
    pendingEndPrizeEditKey = key;
    const sharedInput = document.getElementById("end-prize-file-shared");
    if (!sharedInput) return;
    sharedInput.value = "";
    sharedInput.click();
};

/* END PRIZE > SAVE — identical "instant save" behavior to CURRENT PRIZE: no
   percentage/quantity allocation modal of any kind, just a direct Firestore
   write and a simple SAVED confirmation. */
window.saveEndPrizeItem = async function(key) {
    if (!window.FirebaseBridge) return;
    const { db, doc, collection, addDoc, updateDoc } = window.FirebaseBridge;
    const combined = endPrizesCombinedList();
    const item = combined.find(x => (x.id || x._localId) === key);
    if (!item) return;

    const finalImageUrl = pendingEndPrizeImageEdits[key] || item.imageUrl;
    if (!finalImageUrl) {
        await customAlert("Missing Image", "Upload or paste a link before saving this prize.", "error");
        return;
    }

    try {
        if (item.id) {
            await updateDoc(doc(db, "end_prizes", item.id), { imageUrl: finalImageUrl, lastModified: new Date().getTime() });
            delete pendingEndPrizeImageEdits[key];
            flashSavedStatus(`endprize-status-${key}`);
        } else {
            /* Same duplicate-card race fix as saveGrandPrizeItem()/saveCustomPrizeItem(). */
            endPrizeMinimumSuppressCount++;
            try {
                endPrizesLocalNew = endPrizesLocalNew.filter(x => x._localId !== item._localId);
                delete pendingEndPrizeImageEdits[key];
                buildEndPrizesListUI();
                await addDoc(collection(db, "end_prizes"), { imageUrl: finalImageUrl, createdAt: new Date().getTime() });
            } finally {
                endPrizeMinimumSuppressCount--;
            }
        }
        await customAlert("Saved", "Prize saved to the End Prize gallery.", "success");
    } catch (err) { await customAlert("Error", "Failed to save this end prize.", "error"); }
};

/* END PRIZE > DELETE — always a true, permanent removal. This section is
   deliberately kept outside the win/archive pipeline entirely: there is no
   "exhausted" state and no archive record is ever created for a deleted
   End Prize slot. */
window.deleteEndPrizeItem = async function(key) {
    const combined = endPrizesCombinedList();
    const item = combined.find(x => (x.id || x._localId) === key);
    if (!item) return;

    const confirmed = await customConfirm("Delete Permanently", "This End Prize will be permanently deleted and will NOT be sent to the Prize Archive. Continue?", "danger");
    if (!confirmed) return;

    delete pendingEndPrizeImageEdits[key];

    if (!item.id) {
        endPrizesLocalNew = endPrizesLocalNew.filter(x => x._localId !== item._localId);
        buildEndPrizesListUI();
        return;
    }

    if (!window.FirebaseBridge) return;
    const { db, doc, deleteDoc } = window.FirebaseBridge;
    try {
        await deleteDoc(doc(db, "end_prizes", item.id));
        await customAlert("Deleted", "End prize permanently deleted.", "success");
    } catch (err) { await customAlert("Error", "Failed to delete this end prize.", "error"); }
};

/* =====================================================================
   PRIZE RATE > CUSTOM PRIZES — fully independent, permanent collection
   ("custom_prizes"). Each doc: { imageUrl, createdAt, dropRate, outcomeType }
   where outcomeType is always "No Prize" (fixed -- the old Prize/No Prize
   toggle has been removed). This collection is fully standalone: it is never
   synced into grand_prizes or end_prizes, and never migrated/archived
   automatically -- entries stay put.
===================================================================== */
function initializeRealtimeCustomPrizesStream() {
    if (customPrizesListenerStarted) return;
    customPrizesListenerStarted = true;
    if (!window.FirebaseBridge) return;
    const { db, collection, query, onSnapshot } = window.FirebaseBridge;

    onSnapshot(query(collection(db, "custom_prizes")), (querySnapshot) => {
        customPrizesDocs = [];
        querySnapshot.forEach(docSnap => { customPrizesDocs.push({ id: docSnap.id, ...docSnap.data() }); });
        customPrizesDocs.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        buildCustomPrizesListUI();
        processExhaustedCustomPrizes();
    });
}

function customPrizesCombinedList() {
    return [...customPrizesDocs, ...customPrizesLocalNew];
}

/* BUGFIX: this was the direct cause of both reported "No Prize" tab bugs --
   the persistent blank slot on load, and the extra blank card left behind
   after a successful save/upload. It used to silently push a brand-new blank
   local card any time the combined list was empty (e.g. before the realtime
   listener had returned data, or for a beat right after a save/addDoc while
   the listener catches up), and that auto-reseeded card was never cleaned up
   once real data arrived. A new slot is now only ever created explicitly via
   the "ADD MORE" button, so an empty list simply renders empty. */
function ensureCustomPrizesMinimum() {
    return;
}

window.buildCustomPrizesListUI = function() {
    const container = document.getElementById("custom-prizes-list-container");
    if (!container) return;
    ensureCustomPrizesMinimum();
    const combined = customPrizesCombinedList();

    let html = "";
    combined.forEach((item) => {
        const key = item.id || item._localId;
        const safeKey = escapeHtml(key);
        const imgUrl = pendingCustomPrizeImageEdits[key] || item.imageUrl || GALLERY_PLACEHOLDER_IMG;
        const isEmptyMedia = isPlaceholderMediaUrl(imgUrl);
        const currentRate = Object.prototype.hasOwnProperty.call(pendingCustomPrizeDropRateEdits, key)
            ? pendingCustomPrizeDropRateEdits[key]
            : (typeof item.dropRate === 'number' && item.dropRate > 0 ? item.dropRate : null);
        let rateButtonsHtml = "";
        NO_PRIZE_RATE_OPTIONS.forEach(rate => {
            const isActive = currentRate === rate;
            rateButtonsHtml += `<button type="button" class="rate-btn${isActive ? ' active' : ''}" onclick="setCustomPrizeDropRatePreset('${safeKey}', ${rate})">${rate}%</button>`;
        });
        const isCustomRateActive = currentRate !== null && !NO_PRIZE_RATE_OPTIONS.includes(currentRate);
        /* No Prize never renders a status/type tag over its thumbnail -- unlike
           Grand Prizes, there is no drop-rate-derived label here at all. */

        html += `
        <div class="past-prize-row grand-prize-row prize-slot-card custom-prize-row">
            <div class="prize-slot-top-row">
                <div class="past-prize-thumb-col">
                    <div class="media-thumb-wrap">
                        <div class="media-shadow-box${isEmptyMedia ? ' is-empty' : ''}">
                            <img src="${imgUrl}" alt="No Prize" class="img-loading" onload="this.classList.remove('img-loading')">
                            <div class="media-placeholder-icon">${MEDIA_PLACEHOLDER_ICON_SVG}</div>
                        </div>
                        <span id="customprize-status-${safeKey}" class="state-indicator hidden thumb-status-badge-overlay"></span>
                    </div>
                </div>
                <div class="past-prize-fields-col grand-prize-fields-col">
                    <div class="past-prize-icon-row grand-prize-icon-row three-col">
                        <button class="icon-mini-btn upload-mini" title="Upload New Image" onclick="editCustomPrizeImageUpload('${safeKey}')"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.36 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/></svg></button>
                        <button class="icon-mini-btn link-mini" title="Paste Image Link" onclick="openLinkInput('customprize-edit-${safeKey}')"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg></button>
                        <button class="icon-mini-btn remove-mini" title="Reset Image" onclick="clearCustomPrizeImage('${safeKey}')"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>
                    </div>
                    <div class="rate-btn-grid one-plus-custom">
                        ${rateButtonsHtml}
                        <div class="manual-rate-input-wrap custom-rate-slot${isCustomRateActive ? ' active-custom' : ''}">
                            <input type="number" inputmode="numeric" pattern="[0-9]*" min="1" max="100" maxlength="3" step="1" placeholder="1-100" value="${isCustomRateActive ? escapeHtml(currentRate) : ''}" oninput="if(this.value.length>3)this.value=this.value.slice(0,3); setCustomPrizeDropRateValue('${safeKey}', this.value, this)">
                            <span class="pct-suffix">%</span>
                        </div>
                    </div>
                    <div class="upload-progress-container hidden" data-progress-key="customprize-${safeKey}">
                        <div class="progress-bar-track"><div class="progress-bar-fill" data-progress-fill></div></div>
                        <div class="progress-stats">
                            <span data-progress-percent>0%</span>
                            <span data-progress-speed>0 KB/s</span>
                        </div>
                    </div>
                </div>
            </div>
            <div class="dual-btn-row card-action-row card-action-row-lg">
                <button class="btn btn-danger-action btn-sm" onclick="deleteCustomPrizeItem('${safeKey}')">REMOVE</button>
                <button class="btn btn-action-green btn-sm" onclick="saveCustomPrizeItem('${safeKey}')">SAVE</button>
            </div>
        </div>`;
    });
    container.innerHTML = html;
    renderDropRateTotal();
};

window.setCustomPrizeDropRatePreset = function(key, rate) {
    pendingCustomPrizeDropRateEdits[key] = rate;
    buildCustomPrizesListUI();
    pulseEditedThenUnsaved(`customprize-status-${key}`);
};

window.setCustomPrizeDropRateValue = function(key, rawValue, inputEl) {
    let num;
    if (rawValue === '' || rawValue === null || rawValue === undefined) {
        /* Field cleared -- stage as "not set" rather than forcing it back to 0,
           so an empty/required field is correctly blocked at save time instead
           of silently becoming a savable 0%. */
        num = null;
    } else {
        num = parseInt(rawValue, 10);
        if (isNaN(num)) {
            num = null;
        } else {
            /* Custom percentage range is strictly 1-100 -- 0 is never a valid,
               savable value, so it's floored to 1 the moment it's typed. */
            num = Math.max(1, Math.min(100, num));
        }
    }
    pendingCustomPrizeDropRateEdits[key] = num;
    /* Hard boundary fix: if the admin typed something outside 1-100, correct
       what's visibly in the field to the clamped value so out-of-range input
       is rejected in real time, not just internally. */
    if (inputEl && num !== null && inputEl.value !== String(num)) inputEl.value = num;
    renderDropRateTotal();
    pulseEditedThenUnsaved(`customprize-status-${key}`);
};

/* Small trash icon inside the image block: resets/removes ONLY the staged or
   saved image asset for this "No Prize" slot, leaving the outcome type and
   percentage completely untouched. Distinct from the big red REMOVE button
   below, which clears the entire slot/configuration. */
window.clearCustomPrizeImage = function(key) {
    pendingCustomPrizeImageEdits[key] = "";
    buildCustomPrizesListUI();
    pulseEditedThenUnsaved(`customprize-status-${key}`);
};

/* QTY control for Custom Prizes -- identical clamping/staging behavior to
   setGrandPrizeQuantityValue(), decremented live by the carousel/lucky draw
   win event and auto-archived by processExhaustedCustomPrizes() at 0. */
window.setCustomPrizeQuantityValue = function(key, rawValue, inputEl) {
    let num = parseInt(rawValue, 10);
    if (isNaN(num) || num < 0) num = 0;
    pendingCustomPrizeQuantityEdits[key] = num;
    if (inputEl && inputEl.value !== String(num)) inputEl.value = num;
    pulseEditedThenUnsaved(`customprize-status-${key}`);
};

window.addNewCustomPrizeCard = async function() {
    const confirmed = await customConfirm("Add New Prize", "Add another blank Custom Prize entry card?", "info");
    if (!confirmed) return;
    pendingCustomPrizeEditKey = null;
    const newLocalId = `new-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    customPrizesLocalNew.push({ _localId: newLocalId, imageUrl: "", dropRate: null, outcomeType: "No Prize", quantity: 1 });
    buildCustomPrizesListUI();
    pulseEditedThenUnsaved(`customprize-status-${newLocalId}`);
};

window.handleCustomPrizeFileChosen = function(input) {
    handleCloudinaryUpload(input, 'customprize');
};

window.editCustomPrizeImageUpload = function(key) {
    pendingCustomPrizeEditKey = key;
    const sharedInput = document.getElementById("custom-prize-file-shared");
    if (!sharedInput) return;
    sharedInput.value = "";
    sharedInput.click();
};

/* NOTE: No Prize slots ("custom_prizes") are now a fully standalone collection.
   The old bridge that mirrored a "Prize" outcome into "grand_prizes" and a
   "No Prize" outcome into "end_prizes" has been removed entirely -- saving,
   editing, or deleting a No Prize slot here has zero side effects on the
   Prize Gallery (Current Prize or End Prize) or the Prize Pool. */

window.saveCustomPrizeItem = async function(key) {
    if (!window.FirebaseBridge) return;
    const { db, doc, collection, addDoc, updateDoc } = window.FirebaseBridge;
    const combined = customPrizesCombinedList();
    const item = combined.find(x => (x.id || x._localId) === key);
    if (!item) return;

    const finalImageUrl = pendingCustomPrizeImageEdits[key] || item.imageUrl;
    if (!finalImageUrl) {
        await customAlert("Missing Image", "Upload or paste a link before saving this prize.", "error");
        return;
    }
    const finalDropRate = Object.prototype.hasOwnProperty.call(pendingCustomPrizeDropRateEdits, key)
        ? pendingCustomPrizeDropRateEdits[key]
        : (typeof item.dropRate === 'number' && item.dropRate > 0 ? item.dropRate : null);

    /* Mandatory drop-rate criteria, mirroring saveGrandPrizeItem(): a save can
       never go through without a preset selected or a valid custom percentage
       between 1-100. Blocked before any state mutation or Firestore write. */
    if (finalDropRate === null || typeof finalDropRate !== 'number' || isNaN(finalDropRate) || finalDropRate < 1 || finalDropRate > 100) {
        await customAlert("Submission Failed", "Please select a preset percentage or enter a valid custom percentage between 1\u2013100 before saving.", "error");
        return;
    }

    /* Outcome is now fixed to "No Prize" -- the Prize/No Prize toggle was
       removed, and this slot never syncs anywhere else. */
    const finalOutcomeType = "No Prize";
    const finalQuantity = Object.prototype.hasOwnProperty.call(pendingCustomPrizeQuantityEdits, key)
        ? pendingCustomPrizeQuantityEdits[key]
        : (typeof item.quantity === 'number' ? item.quantity : 1);

    try {
        if (item.id) {
            await updateDoc(doc(db, "custom_prizes", item.id), {
                imageUrl: finalImageUrl,
                dropRate: finalDropRate,
                outcomeType: finalOutcomeType,
                quantity: finalQuantity,
                lastModified: new Date().getTime()
            });
            delete pendingCustomPrizeImageEdits[key];
            delete pendingCustomPrizeDropRateEdits[key];
            delete pendingCustomPrizeQuantityEdits[key];
            flashSavedStatus(`customprize-status-${key}`);
        } else {
            customPrizeMinimumSuppressCount++;
            try {
                customPrizesLocalNew = customPrizesLocalNew.filter(x => x._localId !== item._localId);
                delete pendingCustomPrizeImageEdits[key];
                delete pendingCustomPrizeDropRateEdits[key];
                delete pendingCustomPrizeQuantityEdits[key];
                buildCustomPrizesListUI();
                await addDoc(collection(db, "custom_prizes"), {
                    imageUrl: finalImageUrl,
                    dropRate: finalDropRate,
                    outcomeType: finalOutcomeType,
                    quantity: finalQuantity,
                    createdAt: new Date().getTime()
                });
            } finally {
                customPrizeMinimumSuppressCount--;
            }
        }
        await customAlert("Saved", "No Prize slot saved.", "success");
    } catch (err) { await customAlert("Error", "Failed to save this prize.", "error"); }
};

window.deleteCustomPrizeItem = async function(key) {
    const combined = customPrizesCombinedList();
    const item = combined.find(x => (x.id || x._localId) === key);
    if (!item) return;

    const confirmed = await customConfirm("Remove Prize", "Are you sure you want to remove this prize entry?", "danger");
    if (!confirmed) return;

    delete pendingCustomPrizeImageEdits[key];
    delete pendingCustomPrizeDropRateEdits[key];
    delete pendingCustomPrizeQuantityEdits[key];

    if (!item.id) {
        /* Removing a not-yet-saved local card simply removes it -- the list is
           allowed to render fully empty now; a new blank slot is only ever
           created again via the "ADD MORE" button. */
        customPrizesLocalNew = customPrizesLocalNew.filter(x => x._localId !== item._localId);
        buildCustomPrizesListUI();
        return;
    }

    if (!window.FirebaseBridge) return;
    const { db, doc, deleteDoc } = window.FirebaseBridge;
    try {
        await deleteDoc(doc(db, "custom_prizes", item.id));
        await customAlert("Deleted", "Custom prize removed.", "success");
    } catch (err) { await customAlert("Error", "Failed to delete this custom prize.", "error"); }
};

/* =====================================================================
   CUSTOM PRIZES > VOLUME CONTROL + AUTO-ARCHIVE ON DISTRIBUTION
   Identical pattern to processExhaustedGrandPrizes() above: the instant a
   Custom Prize's admin-defined `quantity` is decremented (by a live win
   event from the carousel/lucky draw, or by editing the QTY field here and
   hitting Save) down to 0, it is copied into "prize_archive" tagged with
   origin: "custom_prizes" and removed from "custom_prizes". If it had a
   linked synced Grand Prizes/Prize Gallery entry, that is removed too.
===================================================================== */
function processExhaustedCustomPrizes() {
    if (!window.FirebaseBridge) return;
    const { db, doc, collection, deleteDoc, runTransaction } = window.FirebaseBridge;

    customPrizesDocs.forEach((item) => {
        if (!item.id) return;
        /* "No Prize" type is a permanent slot: it has no quantity restriction
           and must never be archived, so it is excluded from this check
           entirely regardless of what its `quantity` field currently holds. */
        if (item.outcomeType === 'No Prize') return;
        if (typeof item.quantity !== 'number' || item.quantity > 0) return;
        if (customPrizeArchivingKeys.has(item.id)) return; /* transfer already in flight for this doc */
        customPrizeArchivingKeys.add(item.id);

        (async () => {
            try {
                /* Atomic archive+delete — same transaction pattern as the Grand Prize
                   path above, so a concurrent Lucky Draw archive of this doc can never
                   produce a duplicate prize_archive entry. The transaction re-reads the
                   doc: if it's already gone (draw got there first) or was restocked,
                   nothing is written. */
                const activeRef = doc(db, "custom_prizes", item.id);
                const archiveRef = doc(collection(db, "prize_archive"));
                let syncedGrandPrizeId = null;
                let syncedEndPrizeId = null;
                let archived = false;
                await runTransaction(db, async (transaction) => {
                    const snap = await transaction.get(activeRef);
                    if (!snap.exists()) return; /* already archived by the Lucky Draw or another tab */
                    const data = snap.data();
                    if (data.outcomeType === 'No Prize') return;
                    if (typeof data.quantity !== 'number' || data.quantity > 0) return; /* restocked meanwhile */
                    syncedGrandPrizeId = data.syncedGrandPrizeId || null;
                    syncedEndPrizeId = data.syncedEndPrizeId || null;
                    transaction.set(archiveRef, {
                        name: "Custom Prize",
                        imageUrl: data.imageUrl || "",
                        dropRate: typeof data.dropRate === 'number' ? data.dropRate : null,
                        quantity: 1,
                        outcomeType: data.outcomeType || "Prize",
                        origin: "custom_prizes",
                        archivedAt: new Date().getTime()
                    });
                    transaction.delete(activeRef);
                    archived = true;
                });
                /* Mirror-doc cleanup happens after the atomic step and only if this
                   client actually performed the archive. */
                if (archived && syncedGrandPrizeId) {
                    try { await deleteDoc(doc(db, "grand_prizes", syncedGrandPrizeId)); } catch (err) { /* already gone */ }
                }
                if (archived && syncedEndPrizeId) {
                    try { await deleteDoc(doc(db, "end_prizes", syncedEndPrizeId)); } catch (err) { /* already gone */ }
                }
                if (archived) console.log('[Lifecycle] Prize depleted and moved to Archive');
            } catch (err) {
                /* Release the guard on failure so the next snapshot gets another
                   chance to archive it instead of being permanently blocked. */
            } finally {
                customPrizeArchivingKeys.delete(item.id);
            }
        })();
    });
}

/* =====================================================================
   PRIZE ARCHIVE — read-only realtime mirror of "prize_archive". Entries land
   here automatically the instant the live draw pipeline retires an asset; the
   Admin Panel never writes to this collection, only displays it.
===================================================================== */
function initializeRealtimePrizeArchiveStream() {
    if (prizeArchiveListenerStarted) return;
    prizeArchiveListenerStarted = true;
    if (!window.FirebaseBridge) return;
    const { db, collection, query, onSnapshot } = window.FirebaseBridge;

    onSnapshot(query(collection(db, "prize_archive")), (querySnapshot) => {
        prizeArchiveDocs = [];
        querySnapshot.forEach(docSnap => { prizeArchiveDocs.push({ id: docSnap.id, ...docSnap.data() }); });
        prizeArchiveDocs.sort((a, b) => (b.archivedAt || b.createdAt || 0) - (a.archivedAt || a.createdAt || 0));
        buildPrizeArchiveListUI();
    });
}

window.buildPrizeArchiveListUI = function() {
    const container = document.getElementById("prize-archive-list-container");
    if (!container) return;

    if (prizeArchiveDocs.length === 0) {
        container.innerHTML = `
        <div class="prize-archive-empty-card">
            <div class="prize-archive-empty-icon">${ARCHIVE_EMPTY_ICON_SVG}</div>
            <p class="prize-archive-empty-text">No prizes archived yet.</p>
        </div>`;
        return;
    }

    let html = "";
    prizeArchiveDocs.forEach((item) => {
        const imgUrl = item.imageUrl || GALLERY_PLACEHOLDER_IMG;
        const isEmptyMedia = isPlaceholderMediaUrl(imgUrl);
        /* Dynamic status tag only -- the legacy "Archived Prize" overhead label
           has been removed entirely. Falls back to the item's outcomeType (or
           plain "Prize") only when the saved percentage doesn't match one of
           the three defined thresholds (90 / 10 / 1-5). */
        const computedTag = computePrizeStatusTag(typeof item.dropRate === 'number' ? item.dropRate : null);
        const tagLabel = escapeHtml(computedTag || item.outcomeType || "Prize");
        const ts = item.archivedAt || item.createdAt;
        const dateLabel = ts ? new Date(ts).toLocaleDateString() : "";
        const timeLabel = ts ? new Date(ts).toLocaleTimeString() : "";
        const safeId = escapeHtml(item.id);
        html += `
        <div class="prize-archive-row">
            <div class="media-shadow-box${isEmptyMedia ? ' is-empty' : ''}">
                <img src="${imgUrl}" alt="${tagLabel}" class="img-loading" onload="this.classList.remove('img-loading')">
                <div class="media-placeholder-icon">${MEDIA_PLACEHOLDER_ICON_SVG}</div>
            </div>
            <div class="prize-archive-info">
                <div class="prize-archive-title-row">
                    <span class="used-badge">${tagLabel}</span>
                </div>
                ${dateLabel ? `<span class="prize-archive-meta">DATE: ${escapeHtml(dateLabel)}</span>` : ''}
                ${timeLabel ? `<span class="prize-archive-meta">TIME: ${escapeHtml(timeLabel)}</span>` : ''}
            </div>
            <button class="icon-mini-btn retake-mini" title="Retake (Restore)" onclick="retakeArchivedPrizeItem('${safeId}')"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg></button>
            <button class="icon-mini-btn del-mini" title="Delete" onclick="deleteArchivedPrizeItem('${safeId}')"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>
        </div>`;
    });
    container.innerHTML = html;
};

/* "Retake" (Restore) action: moves an archived item back to its original
   active section. Each archive doc carries an `origin` field written at
   archive-time ("grand_prizes" or "custom_prizes") so this always knows
   exactly where to push the restored record back to. */
window.retakeArchivedPrizeItem = async function(id) {
    const item = prizeArchiveDocs.find(x => x.id === id);
    if (!item) return;
    const confirmed = await customConfirm("Retake Prize", "Restore this archived prize back to its original active section?", "info");
    if (!confirmed) return;
    if (!window.FirebaseBridge) return;
    const { db, doc, collection, addDoc, updateDoc, deleteDoc } = window.FirebaseBridge;
    const origin = item.origin || 'grand_prizes';
    try {
        if (origin === 'custom_prizes') {
            const restoredImage = item.imageUrl || "";
            await addDoc(collection(db, "custom_prizes"), {
                imageUrl: restoredImage,
                dropRate: typeof item.dropRate === 'number' ? item.dropRate : 0,
                outcomeType: "No Prize",
                quantity: typeof item.quantity === 'number' && item.quantity > 0 ? item.quantity : 1,
                createdAt: new Date().getTime()
            });
        } else {
            await addDoc(collection(db, "grand_prizes"), {
                imageUrl: item.imageUrl || "",
                dropRate: typeof item.dropRate === 'number' ? item.dropRate : null,
                quantity: typeof item.quantity === 'number' && item.quantity > 0 ? item.quantity : 1,
                createdAt: new Date().getTime()
            });
        }
        await deleteDoc(doc(db, "prize_archive", id));
        await customAlert("Restored", "Prize has been restored to its original section.", "success");
    } catch (err) { await customAlert("Error", "Failed to restore this archived prize.", "error"); }
};

/* Manual prune action for the Prize Archive. This is the one write the Admin
   Panel is allowed to perform against "prize_archive" (the collection itself
   stays a read-only realtime mirror of the live draw pipeline otherwise) --
   it exists purely so admins can clear out old/unwanted archived entries. */
window.deleteArchivedPrizeItem = async function(id) {
    const confirmed = await customConfirm("Remove Archived Prize", "Are you sure you want to permanently delete this archived entry?", "danger");
    if (!confirmed) return;
    if (!window.FirebaseBridge) return;
    const { db, doc, deleteDoc } = window.FirebaseBridge;
    try {
        await deleteDoc(doc(db, "prize_archive", id));
        await customAlert("Deleted", "Archived prize removed.", "success");
    } catch (err) { await customAlert("Error", "Failed to delete this archived prize.", "error"); }
};

window.handleCloudinaryUpload = async function(inputElem, type) {
    if (!inputElem.files || !inputElem.files[0]) return;
    const file = inputElem.files[0];
    inputElem.value = ""; /* reset now so choosing the identical file again later still triggers 'change' */

    /* Grand Prizes / Custom Prizes / End Prizes render as dynamic lists (one row
       per item), so their progress UI is keyed per stable card id (e.g.
       "grandprize-abc123" / "customprize-abc123" / "endprize-abc123") instead
       of a single static id. This mirrors the exact same KB/s transfer-rate
       animation logic used elsewhere. */
    let progressKey = type;
    if (type === 'grandprize' && pendingGrandPrizeEditKey !== null) {
        progressKey = `grandprize-${pendingGrandPrizeEditKey}`;
    } else if (type === 'customprize' && pendingCustomPrizeEditKey !== null) {
        progressKey = `customprize-${pendingCustomPrizeEditKey}`;
    } else if (type === 'endprize' && pendingEndPrizeEditKey !== null) {
        progressKey = `endprize-${pendingEndPrizeEditKey}`;
    }

    /* THE MISSING-ANIMATION FIX: progress UI is looked up by data-progress-key
       across every matching node instead of a single document.getElementById()
       call. Grand Prizes render the exact same card (and an identically-keyed
       progress container) simultaneously in both the Prize Gallery > CURRENT
       PRIZE tab and the Prize Rate > Grand Prizes tab -- getElementById() would
       silently grab whichever copy sits first in the DOM, even if that copy
       happens to be the one currently hidden behind an inactive tab, which is
       exactly why the uploading animation could appear to not run at all.
       Updating every matching node keeps it visible no matter which tab is
       actually on screen, and is applied uniformly to Custom/End Prizes too. */
    const progressSelector = `[data-progress-key="${progressKey}"]`;
    const showProgress = () => {
        document.querySelectorAll(progressSelector).forEach(el => {
            el.classList.remove("hidden");
            const fillBar = el.querySelector('[data-progress-fill]');
            const percentSpan = el.querySelector('[data-progress-percent]');
            const speedSpan = el.querySelector('[data-progress-speed]');
            if (fillBar) fillBar.style.width = '0%';
            if (percentSpan) percentSpan.innerText = '0%';
            if (speedSpan) speedSpan.innerText = '0 KB/s';
        });
    };
    const hideProgress = () => {
        document.querySelectorAll(progressSelector).forEach(el => el.classList.add("hidden"));
    };
    showProgress();

    const formData = new FormData();
    formData.append('file', file);
    formData.append('upload_preset', 'tzerone_giveaway');

    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://api.cloudinary.com/v1_1/dqxkdcnx4/image/upload');

    let startTime = new Date().getTime();

    xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
            const percent = Math.round((e.loaded / e.total) * 100);
            const timeElapsed = (new Date().getTime() - startTime) / 1000;
            const bytesPerSec = e.loaded / (timeElapsed || 1);
            const kbPerSec = (bytesPerSec / 1024).toFixed(1);
            document.querySelectorAll(progressSelector).forEach(el => {
                const fillBar = el.querySelector('[data-progress-fill]');
                const percentSpan = el.querySelector('[data-progress-percent]');
                const speedSpan = el.querySelector('[data-progress-speed]');
                if (fillBar) fillBar.style.width = percent + '%';
                if (percentSpan) percentSpan.innerText = percent + '%';
                if (speedSpan) speedSpan.innerText = kbPerSec + ' KB/s';
            });
        }
    };

    xhr.onload = async () => {
        if (xhr.status === 200) {
            const res = JSON.parse(xhr.responseText);
            const secureUrl = res.secure_url;

            if (type === 'grandprize') {
                if (pendingGrandPrizeEditKey !== null) {
                    pendingGrandPrizeImageEdits[pendingGrandPrizeEditKey] = secureUrl;
                    buildGrandPrizesListUI();
                    buildGrandPrizesRateListUI();
                    pulseEditedThenUnsaved(`grandprize-status-${pendingGrandPrizeEditKey}`);
                    pulseEditedThenUnsaved(`grandprizerate-status-${pendingGrandPrizeEditKey}`);
                    await customAlert("Upload Complete", "Image staged for this prize. Click its SAVE icon to publish.", "success");
                }
                pendingGrandPrizeEditKey = null;
            } else if (type === 'customprize') {
                if (pendingCustomPrizeEditKey !== null) {
                    pendingCustomPrizeImageEdits[pendingCustomPrizeEditKey] = secureUrl;
                    buildCustomPrizesListUI();
                    pulseEditedThenUnsaved(`customprize-status-${pendingCustomPrizeEditKey}`);
                    await customAlert("Upload Complete", "Image staged for this prize. Click its SAVE icon to publish.", "success");
                }
                pendingCustomPrizeEditKey = null;
            } else if (type === 'endprize') {
                if (pendingEndPrizeEditKey !== null) {
                    pendingEndPrizeImageEdits[pendingEndPrizeEditKey] = secureUrl;
                    buildEndPrizesListUI();
                    pulseEditedThenUnsaved(`endprize-status-${pendingEndPrizeEditKey}`);
                    await customAlert("Upload Complete", "Image staged for this prize. Click its SAVE icon to publish.", "success");
                }
                pendingEndPrizeEditKey = null;
            }
        } else {
            await customAlert("Upload Failed", "Cloudinary storage error.", "error");
        }
        setTimeout(hideProgress, 1500);
    };

    xhr.onerror = async () => {
        await customAlert("Upload Failed", "Network exception occurred.", "error");
        hideProgress();
    };

    xhr.send(formData);
};
/* =====================================================================
   SESSION GATE
   This page never shows a login form of its own. It silently checks the
   session Firebase already restored (persisted via browserSessionPersistence
   from index.html): if it's valid the dashboard reveals instantly, and if
   it isn't, the admin is bounced straight back to the Home login screen.
===================================================================== */
if (window.FirebaseBridge && window.FirebaseBridge.auth) {
    window.FirebaseBridge.onAuthStateChanged(window.FirebaseBridge.auth, (user) => {
        if (user) {
            document.getElementById("admin-panel-view").classList.remove("hidden");
            document.documentElement.classList.remove("session-checking");
            switchGrandPrizesPrimaryTab("gallery");
            switchGalleryPrimaryTab("current");
            switchGrandPrizesSubTab("rate");
            switchPrizeRateInnerTab("grand");
            initializeRealtimeGrandPrizesStream();
            initializeRealtimeEndPrizesStream();
            initializeRealtimeCustomPrizesStream();
            renderDropRateTotal();
        } else {
            window.location.replace("../index.html");
        }
    });
} else {
    window.location.replace("../index.html");
}