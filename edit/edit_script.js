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

async function fetchDocOnce(docRef) {
    if (!window.FirebaseBridge) return null;
    try {
        const snap = await window.FirebaseBridge.getDoc(docRef);
        return snap.exists() ? snap.data() : null;
    } catch (e) {
        return null;
    }
}
/* =====================================================================
   GLOBAL STATE (Edit: Latest Prize / Past Prize / Edit Elements)
===================================================================== */
let pendingCaptionResolver = null;
let pendingLinkTargetKey = null;

let activePastPrizeItems = [];
let pastPrizePendingImageEdits = {};
let pastPrizeAddPendingUrl = null;
let pendingPastFileEditIndex = null;
let selectedCreatorRatio = null;
/* The ratio that is actually saved/live on the server, as distinct from
   selectedCreatorRatio (which just tracks whichever tab is being previewed).
   The "USED" badge is driven by this value only. */
let savedCreatorRatio = null;

const GALLERY_PLACEHOLDER_IMG = "data:image/svg+xml;utf8," + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='10' fill='#343454'/><circle cx='22' cy='24' r='6' fill='#555770'/><path d='M8 50 L26 32 L38 44 L48 30 L58 50 Z' fill='#555770'/></svg>"
);

/* A genuinely blank 1x1 pixel (no visible artwork at all), used whenever an <img>
   element itself needs to be reset in place (e.g. removing an asset). Unlike
   GALLERY_PLACEHOLDER_IMG -- which is a visible icon graphic meant for list-style
   thumbnails that render straight into their final state -- swapping this blank
   pixel into an existing <img> can never paint a stray icon frame inside the <img>
   itself while its opacity/fade transition runs; the single CSS-driven
   .media-placeholder-icon overlay remains the only glyph the admin ever sees. */
const TRANSPARENT_PIXEL_GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/* Shared fallback gallery/image glyph used inside every 1:1 shadow-box placeholder
   (Latest Prize, Past Prize, Grand Prizes, Edit Elements). Centered via .media-placeholder-icon.
   This is the single global icon mandated for all image placeholder / gallery states. */
const MEDIA_PLACEHOLDER_ICON_SVG = `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M6.205 3h11.59c1.114 0 1.519.116 1.926.334.407.218.727.538.945.945.218.407.334.811.334 1.926v7.51l-4.391-4.053a1.5 1.5 0 0 0-2.265.27l-3.13 4.695-2.303-1.48a1.5 1.5 0 0 0-1.96.298L3.005 18.15A12.98 12.98 0 0 1 3 17.795V6.205c0-1.115.116-1.519.334-1.926.218-.407.538-.727.945-.945C4.686 3.116 5.09 3 6.205 3zm9.477 8.53L21 16.437v1.357c0 1.114-.116 1.519-.334 1.926a2.272 2.272 0 0 1-.945.945c-.407.218-.811.334-1.926.334H6.205c-1.115 0-1.519-.116-1.926-.334a2.305 2.305 0 0 1-.485-.345L8.2 15.067l2.346 1.508a1.5 1.5 0 0 0 2.059-.43l3.077-4.616zM7.988 6C6.878 6 6 6.832 6 7.988 6 9.145 6.879 10 7.988 10 9.121 10 10 9.145 10 7.988 10 6.832 9.121 6 7.988 6z" fill="#ffffff"></path></svg>`;
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
   Used globally across Latest Prize, Past Prize, Grand Prizes, and Edit Elements. */
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

/* Keeps the Latest Prize preview's 1:1 shadow box in sync: the moment a real image
   is loaded the fallback SVG icon clears out, and it gracefully reappears if the
   image is ever reset back to a placeholder/empty state. */
function refreshMediaShadowBoxState(imgElement) {
    if (!imgElement) return;
    const wrapper = imgElement.closest('.media-shadow-box') || imgElement.closest('.creator-preview-frame');
    if (!wrapper) return;
    const currentUrl = imgElement.getAttribute('data-new-url') || imgElement.getAttribute('src');
    wrapper.classList.toggle('is-empty', isPlaceholderMediaUrl(currentUrl));
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
window.requestCaptionInput = function(previewUrl) {
    return new Promise(resolve => {
        pendingCaptionResolver = resolve;
        document.getElementById("caption-input-field").value = "";
        const previewBox = document.getElementById("caption-preview-box");
        const previewImg = document.getElementById("caption-preview-img");
        if (previewUrl) {
            previewImg.src = previewUrl;
            previewBox.classList.remove("hidden");
        } else {
            previewBox.classList.add("hidden");
        }
        document.getElementById("caption-input-overlay").classList.remove("hidden");
        document.getElementById("caption-input-field").focus();
    });
};
window.confirmCaptionInput = function() {
    const val = document.getElementById("caption-input-field").value.trim();
    document.getElementById("caption-input-overlay").classList.add("hidden");
    if (pendingCaptionResolver) { pendingCaptionResolver(val || "UNTITLED PRIZE"); pendingCaptionResolver = null; }
};
window.cancelCaptionInput = function() {
    document.getElementById("caption-input-overlay").classList.add("hidden");
    if (pendingCaptionResolver) { pendingCaptionResolver(null); pendingCaptionResolver = null; }
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
   Upload/Link operations work perfectly whether the admin pastes a raw link or
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

    if (targetKey === 'latest') {
        const imgElement = document.getElementById("admin-prize-preview-img");
        imgElement.classList.add('img-loading');
        imgElement.src = val;
        imgElement.setAttribute("data-new-url", val);
        refreshMediaShadowBoxState(imgElement);
        pulseEditedThenUnsaved('latest-status-indicator');
        await customAlert("Link Applied", "Image link applied to the live preview. Click SAVE to publish it.", "success");
    } else if (targetKey === 'creator') {
        const imgElement = document.getElementById("admin-creator-preview-img");
        imgElement.classList.add('img-loading');
        imgElement.src = val;
        imgElement.setAttribute("data-new-url", val);
        refreshMediaShadowBoxState(imgElement);
        pulseEditedThenUnsaved('creator-status-indicator');
        await customAlert("Link Applied", "Creator icon link applied. Click SAVE to publish it.", "success");
    } else if (typeof targetKey === 'string' && targetKey.startsWith('notice-slot-')) {
        const idx = parseInt(targetKey.replace('notice-slot-', ''), 10);
        noticePendingImageEdits[idx] = val;
        buildNoticeSlotsUI();
        pulseEditedThenUnsaved(`notice-slot-status-${idx}`);
        await customAlert("Link Applied", "Image link staged for this notice. Click its SAVE button to publish.", "success");
    } else if (targetKey === 'past-new') {
        pastPrizeAddPendingUrl = val;
        const caption = await requestCaptionInput(val);
        if (caption === null) { pastPrizeAddPendingUrl = null; return; }
        await persistNewPastPrizeItem(val, caption);
    } else if (typeof targetKey === 'string' && targetKey.startsWith('past-edit-')) {
        const idx = parseInt(targetKey.replace('past-edit-', ''), 10);
        pastPrizePendingImageEdits[idx] = val;
        buildPastPrizeGridUI();
        pulseEditedThenUnsaved(`past-status-${idx}`);
        await customAlert("Link Applied", "Image link staged for this item. Click its SAVE icon to publish.", "success");
    }
};
window.switchPrizeSubTab = function(tabName) {
    document.querySelectorAll("#prize-segmented-tabs .segment-btn").forEach(btn => btn.classList.remove("active"));
    const idx = { latest: 0, past: 1, notice: 2, elements: 3 }[tabName];
    document.querySelectorAll("#prize-segmented-tabs .segment-btn")[idx].classList.add("active");
    document.getElementById("prize-sub-latest").classList.toggle("active", tabName === 'latest');
    document.getElementById("prize-sub-latest").classList.toggle("hidden", tabName !== 'latest');
    document.getElementById("prize-sub-past").classList.toggle("active", tabName === 'past');
    document.getElementById("prize-sub-past").classList.toggle("hidden", tabName !== 'past');
    document.getElementById("prize-sub-notice").classList.toggle("active", tabName === 'notice');
    document.getElementById("prize-sub-notice").classList.toggle("hidden", tabName !== 'notice');
    document.getElementById("prize-sub-elements").classList.toggle("active", tabName === 'elements');
    document.getElementById("prize-sub-elements").classList.toggle("hidden", tabName !== 'elements');
    if (tabName === 'past') buildPastPrizeGridUI();
    if (tabName === 'notice') buildNoticeSlotsUI();
}
function initializeRealtimePrizeConfigStreams() {
    if (!window.FirebaseBridge) return;
    const { db, doc, onSnapshot } = window.FirebaseBridge;

    onSnapshot(doc(db, "configuration", "livePrize"), (docSnapshot) => {
        let imgUrl = "", captionStr = "Loading prize details...";
        if (docSnapshot.exists()) {
            const data = docSnapshot.data();
            if (data.imageUrl) imgUrl = data.imageUrl;
            captionStr = (data.caption && data.caption.trim()) ? data.caption : "Untitled Latest Prize";
        }
        const adminImg = document.getElementById("admin-prize-preview-img");
        if (imgUrl) {
            if(adminImg.src !== imgUrl) { adminImg.classList.add("img-loading"); adminImg.src = imgUrl; }
        }
        refreshMediaShadowBoxState(adminImg);
        document.getElementById("admin-prize-preview-cap").innerText = captionStr;
    });

    /* NOTICE EDIT (dynamic multi-slot): configuration/notice now stores { items: [...] },
       the same array shape as configuration/pastPrize. Any "draft" (unsaved) slots the
       admin is actively building via ADD MORE are preserved across this resync -- only
       the "saved" portion of noticeSlots is rebuilt from the authoritative server data. */
    onSnapshot(doc(db, "configuration", "notice"), (docSnapshot) => {
        let items = [];
        if (docSnapshot.exists()) {
            const data = docSnapshot.data();
            if (Array.isArray(data.items)) {
                items = data.items;
            } else if (data.imageUrl) {
                /* Backward-compatible migration path: legacy single-notice records
                   (imageUrl/caption on the doc root) render as a single saved slot. */
                items = [{ imageUrl: data.imageUrl, caption: data.caption || "" }];
            }
        }
        activeNoticeItems = items;
        const prevSavedCount = noticeSlots.filter(s => s.saved).length;
        const draftSlots = noticeSlots.filter(s => !s.saved);
        noticeSlots = items.map((it, i) => ({ imageUrl: it.imageUrl || '', caption: it.caption || '', saved: true, firestoreIndex: i }));
        noticeSlots = noticeSlots.concat(draftSlots);
        if (noticeSlots.length === 0) noticeSlots.push({ imageUrl: '', caption: '', saved: false, firestoreIndex: null });
        /* Slot indices are only stable across this rebuild when the saved-item count is
           unchanged (a pure echo of a local save). If items were added/removed, every
           index-keyed staged image may now point at the wrong card — drop them instead
           of letting a stale upload publish onto a neighboring notice. */
        if (items.length !== prevSavedCount) noticePendingImageEdits = {};
        buildNoticeSlotsUI();
    });

    onSnapshot(doc(db, "configuration", "pastPrize"), (docSnapshot) => {
        activePastPrizeItems = [];
        if (docSnapshot.exists()) {
            const data = docSnapshot.data();
            if (Array.isArray(data.items)) {
                activePastPrizeItems = data.items;
            } else if (data.imageUrl) {
                activePastPrizeItems = [{ imageUrl: data.imageUrl, caption: data.caption || "Previous prize" }];
            }
        }
        buildPastPrizeGridUI();
    });

    onSnapshot(doc(db, "configuration", "creatorIcon"), (docSnapshot) => {
        const badgeImg = document.getElementById("admin-creator-preview-img");
        if (!badgeImg) return;
        if (docSnapshot.exists()) {
            const data = docSnapshot.data();
            if (data.imageUrl && badgeImg.src !== data.imageUrl) { badgeImg.classList.add("img-loading"); badgeImg.src = data.imageUrl; }
            if (data.aspectRatio) {
                selectedCreatorRatio = data.aspectRatio;
                savedCreatorRatio = data.aspectRatio;
                applyCreatorRatioIndicator(data.aspectRatio);
                document.querySelectorAll('#creator-ratio-row .ratio-toggle-btn').forEach(btn => {
                    btn.classList.toggle('active', btn.getAttribute('data-ratio') === data.aspectRatio);
                });
            }
        }
        refreshMediaShadowBoxState(badgeImg);
    });

}
window.buildPastPrizeGridUI = function() {
    const container = document.getElementById("past-prize-list-container");
    if (!container) return;
    if (activePastPrizeItems.length === 0) {
        container.innerHTML = `<div class="empty-state-text">No past prizes found.</div>`;
        return;
    }
    let html = "";
    activePastPrizeItems.forEach((item, index) => {
        const imgUrl = pastPrizePendingImageEdits[index] || item.imageUrl || GALLERY_PLACEHOLDER_IMG;
        const isEmptyMedia = isPlaceholderMediaUrl(imgUrl);
        html += `
        <div class="past-prize-row">
            <div class="past-prize-thumb-col">
                <div class="media-shadow-box${isEmptyMedia ? ' is-empty' : ''}">
                    <img src="${imgUrl}" alt="Past Prize">
                    <div class="media-placeholder-icon">${MEDIA_PLACEHOLDER_ICON_SVG}</div>
                    <span id="past-status-${index}" class="state-indicator thumb-status-badge hidden"></span>
                </div>
            </div>
            <div class="past-prize-fields-col">
                <input type="text" id="past-prize-cap-${index}" value="${escapeHtml(item.caption || '')}" placeholder="CAPTION">
                <div class="past-prize-icon-row">
                    <button class="icon-mini-btn upload-mini" title="Upload New Image" onclick="editPastPrizeImageUpload(${index})"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.36 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/></svg></button>
                    <button class="icon-mini-btn link-mini" title="Paste Image Link" onclick="openLinkInput('past-edit-${index}')"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg></button>
                    <button class="icon-mini-btn remove-mini" title="Remove" onclick="removePastPrizeItem(${index})"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>
                    <button class="icon-mini-btn save-mini" title="Save" onclick="savePastPrizeEdit(${index})"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"/></svg></button>
                </div>
                <div id="upload-progress-past-item-${index}" class="upload-progress-container hidden">
                    <div class="progress-bar-track"><div id="progress-bar-fill-past-item-${index}" class="progress-bar-fill"></div></div>
                    <div class="progress-stats">
                        <span id="progress-percent-past-item-${index}">0%</span>
                        <span id="progress-speed-past-item-${index}">0 KB/s</span>
                    </div>
                </div>
            </div>
        </div>`;
    });
    container.innerHTML = html;
};

window.editPastPrizeImageUpload = function(index) {
    pendingPastFileEditIndex = index;
    document.getElementById("past-item-file-shared").click();
};

window.savePastPrizeEdit = async function(index) {
    const newCap = document.getElementById(`past-prize-cap-${index}`).value;
    const newImg = pastPrizePendingImageEdits[index];
    /* Per-object copy (not just a shallow array spread) so a failed write can never
       leave half-mutated objects sitting inside the live activePastPrizeItems cache. */
    const items = activePastPrizeItems.map(it => ({ ...it }));
    if (!items[index]) return;
    if (newImg) items[index].imageUrl = newImg;
    items[index].caption = newCap;

    if (!window.FirebaseBridge) return;
    const { db, doc, setDoc } = window.FirebaseBridge;
    try {
        await setDoc(doc(db, "configuration", "pastPrize"), { items, lastModified: new Date().getTime() }, { merge: true });
        delete pastPrizePendingImageEdits[index];
        flashSavedStatus(`past-status-${index}`);
        await customAlert("Saved", "Past prize updated successfully.", "success");
    } catch (err) { await customAlert("Error", "Failed to update past prize.", "error"); }
};

window.removePastPrizeItem = async function(index) {
    const confirmed = await customConfirm("Remove", "Delete this past prize?", "danger");
    if (!confirmed) return;
    const items = [...activePastPrizeItems];
    items.splice(index, 1);
    if (!window.FirebaseBridge) return;
    const { db, doc, setDoc } = window.FirebaseBridge;
    try {
        await setDoc(doc(db, "configuration", "pastPrize"), { items, lastModified: new Date().getTime() }, { merge: true });
        /* The array was restructured (indices shifted down past this slot), so every
           index-keyed staged image is now potentially pointing at the wrong item —
           drop them all rather than publish an image onto a neighboring prize. */
        pastPrizePendingImageEdits = {};
        await customAlert("Deleted", "Past prize removed.", "success");
    } catch (err) { await customAlert("Error", "Failed to delete past prize.", "error"); }
};

window.persistNewPastPrizeItem = async function(url, caption) {
    const items = [{ imageUrl: url, caption }, ...activePastPrizeItems];
    if (!window.FirebaseBridge) return;
    const { db, doc, setDoc } = window.FirebaseBridge;
    try {
        await setDoc(doc(db, "configuration", "pastPrize"), { items, lastModified: new Date().getTime() }, { merge: true });
        /* Prepending shifts every existing index up by one — invalidate all
           index-keyed staged images so none land on the wrong item later. */
        pastPrizePendingImageEdits = {};
        await customAlert("Added", "New past prize added.", "success");
    } catch (err) { await customAlert("Error", "Failed to add past prize.", "error"); }
};

window.addPastPrizeViaUpload = function() {
    pendingPastFileEditIndex = -1;
    document.getElementById("past-item-file-shared").click();
};

window.addPastPrizeViaLink = function() {
    openLinkInput('past-new');
};

window.handlePastItemFileChosen = function(input) {
    handleCloudinaryUpload(input, 'past-item');
};

/* Drag-and-drop counterpart to addPastPrizeViaUpload(): a file dropped onto the
   "UPLOAD IMAGE" toolbar button is funneled through the exact same shared file
   input + handleCloudinaryUpload('past-item') pipeline as a manual click-to-pick,
   so validation, progress UI, and the Firestore write path are identical either way. */
window.handlePastPrizeImageDrop = function(evt) {
    const dt = evt.dataTransfer;
    if (!dt || !dt.files || !dt.files.length) return;
    const file = dt.files[0];
    if (!file.type || !file.type.startsWith('image/')) {
        customAlert("Invalid File", "Please drop a valid image file.", "error");
        return;
    }
    pendingPastFileEditIndex = -1;
    const sharedInput = document.getElementById("past-item-file-shared");
    const transfer = new DataTransfer();
    transfer.items.add(file);
    sharedInput.files = transfer.files;
    handlePastItemFileChosen(sharedInput);
};

window.togglePastPrizeSeeMore = function() {
    console.log("Toggle 'See More' state triggered.");
};

window.handleCloudinaryUpload = async function(inputElem, type) {
    if (!inputElem.files || !inputElem.files[0]) return;
    const file = inputElem.files[0];
    inputElem.value = ""; /* reset now so choosing the identical file again later still triggers 'change' */

    /* Past Prize items in this list render dynamically (one row per item), so its
       progress UI is keyed per index instead of a single static id like the
       Latest Prize / Creator Icon sections use. This mirrors the exact same
       KB/s transfer-rate animation logic across every section panel. */
    const progressKey = (type === 'past-item' && pendingPastFileEditIndex !== null && pendingPastFileEditIndex !== -1)
        ? `past-item-${pendingPastFileEditIndex}`
        : (type === 'notice-item' && pendingNoticeFileEditIndex !== null)
        ? `notice-item-${pendingNoticeFileEditIndex}`
        : type;

    const progressContainer = document.getElementById(`upload-progress-${progressKey}`);
    const percentSpan = document.getElementById(`progress-percent-${progressKey}`);
    const speedSpan = document.getElementById(`progress-speed-${progressKey}`);
    const fillBar = document.getElementById(`progress-bar-fill-${progressKey}`);

    if (progressContainer) progressContainer.classList.remove("hidden");
    if (fillBar) fillBar.style.width = '0%';
    if (percentSpan) percentSpan.innerText = '0%';
    if (speedSpan) speedSpan.innerText = '0 KB/s';

    const formData = new FormData();
    formData.append('file', file);
    formData.append('upload_preset', 'tzerone_giveaway');

    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://api.cloudinary.com/v1_1/dqxkdcnx4/image/upload');

    let startTime = new Date().getTime();

    xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
            const percent = Math.round((e.loaded / e.total) * 100);
            if (fillBar) fillBar.style.width = percent + '%';
            if (percentSpan) percentSpan.innerText = percent + '%';
            const timeElapsed = (new Date().getTime() - startTime) / 1000;
            const bytesPerSec = e.loaded / (timeElapsed || 1);
            const kbPerSec = (bytesPerSec / 1024).toFixed(1);
            if (speedSpan) speedSpan.innerText = kbPerSec + ' KB/s';
        }
    };

    xhr.onload = async () => {
        if (xhr.status === 200) {
            const res = JSON.parse(xhr.responseText);
            const secureUrl = res.secure_url;

            if (type === 'latest') {
                const imgElement = document.getElementById("admin-prize-preview-img");
                imgElement.classList.add('img-loading');
                imgElement.src = secureUrl;
                imgElement.setAttribute("data-new-url", secureUrl);
                refreshMediaShadowBoxState(imgElement);
                pulseEditedThenUnsaved('latest-status-indicator');
                await customAlert("Upload Complete", "Image processed successfully. Click SAVE to publish it live.", "success");
            } else if (type === 'creator') {
                const imgElement = document.getElementById("admin-creator-preview-img");
                imgElement.classList.add('img-loading');
                imgElement.src = secureUrl;
                imgElement.setAttribute("data-new-url", secureUrl);
                refreshMediaShadowBoxState(imgElement);
                pulseEditedThenUnsaved('creator-status-indicator');
                await customAlert("Upload Complete", "Creator icon uploaded. Click SAVE to publish it live.", "success");
            } else if (type === 'notice-item') {
                if (pendingNoticeFileEditIndex !== null && noticeSlots[pendingNoticeFileEditIndex]) {
                    noticePendingImageEdits[pendingNoticeFileEditIndex] = secureUrl;
                    buildNoticeSlotsUI();
                    pulseEditedThenUnsaved(`notice-slot-status-${pendingNoticeFileEditIndex}`);
                    await customAlert("Upload Complete", "Image staged for this notice. Click its SAVE button to publish.", "success");
                }
                pendingNoticeFileEditIndex = null;
            } else if (type === 'past-item') {
                if (pendingPastFileEditIndex === -1) {
                    const caption = await requestCaptionInput(secureUrl);
                    if (caption !== null) await persistNewPastPrizeItem(secureUrl, caption);
                } else if (pendingPastFileEditIndex !== null) {
                    pastPrizePendingImageEdits[pendingPastFileEditIndex] = secureUrl;
                    buildPastPrizeGridUI();
                    pulseEditedThenUnsaved(`past-status-${pendingPastFileEditIndex}`);
                    await customAlert("Upload Complete", "Image staged for this item. Click its SAVE icon to publish.", "success");
                }
                pendingPastFileEditIndex = null;
            }
        } else {
            await customAlert("Upload Failed", "Cloudinary storage error.", "error");
        }
        setTimeout(() => { if (progressContainer) progressContainer.classList.add("hidden"); }, 1500);
    };

    xhr.onerror = async () => {
        await customAlert("Upload Failed", "Network exception occurred.", "error");
        if (progressContainer) progressContainer.classList.add("hidden");
    };

    xhr.send(formData);
};

window.removeImageAsset = async function(type) {
    const isConfirmed = await customConfirm("Remove Image", "Reset this image to the default placeholder? Click SAVE afterwards to publish the change.", "danger");
    if (!isConfirmed) return;
    const idMap = { latest: 'admin-prize-preview-img', creator: 'admin-creator-preview-img' };
    const statusMap = { latest: 'latest-status-indicator', creator: 'creator-status-indicator' };
    const id = idMap[type] || 'admin-creator-preview-img';
    const statusId = statusMap[type] || 'creator-status-indicator';
    const imgElement = document.getElementById(id);
    /* No network fetch is happening here -- this is an instant local reset -- so the
       'img-loading' skeleton class is intentionally left off. Using the blank pixel
       (instead of the visible GALLERY_PLACEHOLDER_IMG icon) as the <img> source means
       the element itself has no artwork to flash while its opacity fades out; only
       the single CSS .media-placeholder-icon overlay appears, cleanly and once. */
    imgElement.classList.remove('img-loading');
    imgElement.src = TRANSPARENT_PIXEL_GIF;
    imgElement.setAttribute("data-new-url", TRANSPARENT_PIXEL_GIF);
    refreshMediaShadowBoxState(imgElement);
    /* Reverting an asset back to its blank/default state reads as an aborted edit --
       flash CANCEL_STAGE, then settle back into UNSAVED_CHANGES_STAGE since the
       reset itself is still only a local change awaiting the bottom SAVE button. */
    setLiveStatusIndicator(statusId, 'cancel');
    setTimeout(() => setLiveStatusIndicator(statusId, 'unsaved'), 1200);
};

/* =====================================================================
   CAPTION LOCAL ACTIONS (Latest Prize) — green/red inline icons act ONLY on
   the top Live Preview component and never touch Firestore. The permanent
   database write only ever happens via the big bottom SAVE button, which
   still calls saveActivePrizeData() untouched below.
===================================================================== */
let latestPrizeCaptionBeforeClear = "";
window.stageCaptionPreviewLocally = function() {
    const inputVal = document.getElementById("admin-input-caption").value.trim();
    if (!inputVal) return;
    document.getElementById("admin-prize-preview-cap").innerText = inputVal;
    pulseEditedThenUnsaved('latest-status-indicator');
};
window.clearCaptionPreviewLocally = async function() {
    const confirmed = await customConfirm("Clear Caption", "Clear the caption from the live preview? Click SAVE afterwards to publish the change.", "danger");
    if (!confirmed) return;
    const capEl = document.getElementById("admin-prize-preview-cap");
    latestPrizeCaptionBeforeClear = capEl.innerText;
    capEl.innerText = "";
    document.getElementById("admin-input-caption").value = "";
    setLiveStatusIndicator('latest-status-indicator', 'cancel');
    setTimeout(() => setLiveStatusIndicator('latest-status-indicator', 'unsaved'), 1200);
};

window.saveActivePrizeData = async function() {
    if (!window.FirebaseBridge) return;
    const { db, doc, setDoc } = window.FirebaseBridge;
    const inputCaption = document.getElementById("admin-input-caption").value.trim();
    const previewImg = document.getElementById("admin-prize-preview-img");

    let finalImageUrl = previewImg.getAttribute("data-new-url") || previewImg.src;
    /* A REMOVE-then-SAVE stages the transparent-pixel data URI — persist that as an
       empty string instead, so every consumer (main website, lucky draw) sees a clean
       "no image" state rather than having to special-case an invisible 1x1 gif. */
    if (isPlaceholderMediaUrl(finalImageUrl)) finalImageUrl = "";
    let finalCaption = inputCaption || document.getElementById("admin-prize-preview-cap").innerText;

    try {
        const liveDocRef = doc(db, "configuration", "livePrize");
        const liveDocData = await fetchDocOnce(liveDocRef);
        if (liveDocData && liveDocData.imageUrl && !isPlaceholderMediaUrl(liveDocData.imageUrl) && liveDocData.imageUrl !== finalImageUrl) {
            const updatedItems = [{ imageUrl: liveDocData.imageUrl, caption: liveDocData.caption || "Previous prize" }, ...activePastPrizeItems];
            await setDoc(doc(db, "configuration", "pastPrize"), { items: updatedItems, lastModified: new Date().getTime() }, { merge: true });
            /* Past-prize indices just shifted (prepend) — staged images keyed by the
               old indices would publish onto the wrong item, so drop them. */
            pastPrizePendingImageEdits = {};
        }

        await setDoc(doc(db, "configuration", "livePrize"), {
            imageUrl: finalImageUrl,
            caption: finalCaption,
            lastModified: new Date().getTime()
        }, { merge: true });

        document.getElementById("admin-input-caption").value = "";
        previewImg.removeAttribute("data-new-url");
        flashSavedStatus('latest-status-indicator');
        await customAlert("Success", "Prize updated. The previous image automatically moved into Past Prize.", "success");
    } catch (err) { await customAlert("Error", "Failed to sync structural values.", "error"); }
}

/* =====================================================================
   DYNAMIC MULTI-NOTICE SYSTEM (Notice Edit)
   Replaces the old single fixed notice record with an array-driven map
   pattern: configuration/notice now stores { items: [{imageUrl, caption}, ...] },
   mirroring the exact same shape/pattern already used by configuration/pastPrize.

   Each rendered card is fully sandboxed by its position (index) in noticeSlots:
   - "saved" slots mirror a real Firestore array index (firestoreIndex).
   - "draft" slots (added via ADD MORE, or upload/link before their first Save)
     exist only in local memory until their own per-card SAVE button is pressed,
     at which point they're appended to the Firestore items array and promoted
     to "saved". Uploading/editing one card never mutates any other card's data,
     and removing a card never regenerates or shifts an unrelated slot's identity
     beyond its natural array position.
===================================================================== */
let activeNoticeItems = [];
let noticeSlots = [];
let noticePendingImageEdits = {};
let pendingNoticeFileEditIndex = null;

window.buildNoticeSlotsUI = function() {
    const container = document.getElementById("notice-slots-container");
    if (!container) return;
    if (noticeSlots.length === 0) {
        container.innerHTML = `<div class="empty-state-text">No notices yet. Tap ADD MORE to create one.</div>`;
        return;
    }
    let html = "";
    noticeSlots.forEach((slot, index) => {
        const imgUrl = noticePendingImageEdits[index] || slot.imageUrl || GALLERY_PLACEHOLDER_IMG;
        const isEmptyMedia = isPlaceholderMediaUrl(imgUrl);
        const captionPreview = escapeHtml(slot.caption || (slot.saved ? "Untitled Notice" : "New Notice"));
        html += `
        <div class="notice-slot-card" data-slot-index="${index}">
            <div class="prize-preview-card">
                <div class="media-shadow-box${isEmptyMedia ? ' is-empty' : ''}">
                    <img id="notice-slot-img-${index}" src="${imgUrl}" alt="Notice" class="img-loading" onload="this.classList.remove('img-loading')">
                    <div class="media-placeholder-icon">${MEDIA_PLACEHOLDER_ICON_SVG}</div>
                </div>
                <div class="prize-preview-info">
                    <p id="notice-slot-cap-preview-${index}">${captionPreview}</p>
                    <div class="live-tag-row">
                        <span class="live-preview-tag">LIVE PREVIEW <span class="live-dot"></span></span>
                        <span id="notice-slot-status-${index}" class="state-indicator hidden"></span>
                    </div>
                </div>
            </div>

            <div class="edit-block">
                <div class="image-action-row">
                    <button type="button" class="image-action-btn" onclick="event.stopPropagation(); triggerNoticeSlotUpload(${index});">
                        <svg viewBox="0 0 24 24" width="30" height="30" fill="#C1E1FF"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.36 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/></svg>
                        <span>UPLOAD</span>
                    </button>
                    <button type="button" class="image-action-btn" onclick="event.stopPropagation(); openLinkInput('notice-slot-${index}');">
                        <svg viewBox="0 0 24 24" width="30" height="30" fill="#C1E1FF"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>
                        <span>LINK</span>
                    </button>
                    <button type="button" class="image-action-btn" onclick="event.stopPropagation(); removeNoticeSlotImage(${index});">
                        <svg viewBox="0 0 24 24" width="30" height="30" fill="#FF3B30"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                        <span>REMOVE</span>
                    </button>
                </div>
                <div id="upload-progress-notice-item-${index}" class="upload-progress-container hidden">
                    <div class="progress-bar-track"><div id="progress-bar-fill-notice-item-${index}" class="progress-bar-fill"></div></div>
                    <div class="progress-stats">
                        <span id="progress-percent-notice-item-${index}">0%</span>
                        <span id="progress-speed-notice-item-${index}">0 KB/s</span>
                    </div>
                </div>
            </div>

            <div class="edit-block">
                <h3 class="edit-block-heading">CAPTION</h3>
                <div class="caption-edit-row">
                    <input type="text" id="notice-slot-cap-${index}" value="${escapeHtml(slot.caption || '')}" placeholder="EDIT CAPTION" oninput="stageNoticeSlotCaptionPreview(${index})">
                    <button class="icon-mini-btn save-mini" title="Save Caption to Live Preview" onclick="stageNoticeSlotCaptionSave(${index})">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"/></svg>
                    </button>
                    <button class="icon-mini-btn del-mini" title="Clear Caption from Live Preview" onclick="clearNoticeSlotCaptionLocally(${index})">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                    </button>
                </div>
            </div>

            <div class="notice-slot-footer">
                <button type="button" class="btn btn-danger-action"${noticeSlots.length <= 1 ? ' disabled title="At least one notice slot must remain"' : ''} onclick="removeNoticeSlot(${index})">REMOVE</button>
                <button type="button" class="btn btn-action-green" onclick="saveNoticeSlotEdit(${index})">SAVE</button>
            </div>
        </div>`;
    });
    container.innerHTML = html;
};

/* Live-preview-only caption reflection: typing in a slot's caption field instantly
   updates that same card's own Live Preview line and flags it UNSAVED, but never
   touches Firestore -- the write only happens when that card's own SAVE is tapped. */
window.stageNoticeSlotCaptionPreview = function(index) {
    const input = document.getElementById(`notice-slot-cap-${index}`);
    const previewEl = document.getElementById(`notice-slot-cap-preview-${index}`);
    if (!input || !previewEl) return;
    previewEl.innerText = input.value.trim() || "Untitled Notice";
    pulseEditedThenUnsaved(`notice-slot-status-${index}`);
};

/* Caption-only inline SAVE (mirrors stageCaptionPreviewLocally used by Latest Prize):
   commits the typed text into this one card's own Live Preview line and flags it
   UNSAVED, but never touches Firestore and never affects any other slot. The actual
   network write for this card still only happens via its own bottom SAVE button. */
window.stageNoticeSlotCaptionSave = function(index) {
    const input = document.getElementById(`notice-slot-cap-${index}`);
    const previewEl = document.getElementById(`notice-slot-cap-preview-${index}`);
    if (!input || !previewEl) return;
    previewEl.innerText = input.value.trim() || "Untitled Notice";
    pulseEditedThenUnsaved(`notice-slot-status-${index}`);
};

/* Caption-only inline REMOVE (mirrors clearCaptionPreviewLocally used by Latest Prize):
   clears just the caption text/preview for this one card locally -- image, other
   slots, and Firestore are left untouched until the card's own SAVE is pressed. */
window.clearNoticeSlotCaptionLocally = async function(index) {
    const input = document.getElementById(`notice-slot-cap-${index}`);
    const previewEl = document.getElementById(`notice-slot-cap-preview-${index}`);
    if (!input || !previewEl) return;
    const confirmed = await customConfirm("Clear Caption", "Clear the caption from this notice's live preview? Click SAVE afterwards to publish the change.", "danger");
    if (!confirmed) return;
    input.value = "";
    previewEl.innerText = "Untitled Notice";
    setLiveStatusIndicator(`notice-slot-status-${index}`, 'cancel');
    setTimeout(() => setLiveStatusIndicator(`notice-slot-status-${index}`, 'unsaved'), 1200);
};

/* GUARDED INSERTION: the "+ ADD MORE" click no longer spawns a slot immediately --
   it must be explicitly confirmed in a modal first, so a stray/accidental tap never
   silently creates an extra empty card. */
window.addNoticeSlot = async function() {
    const confirmed = await customConfirm("Add Notice Slot?", "Create a new empty notice slot below the existing ones?", "info");
    if (!confirmed) return;

    noticeSlots.push({ imageUrl: '', caption: '', saved: false, firestoreIndex: null });
    buildNoticeSlotsUI();
    /* Scroll the freshly spawned card into view so the admin immediately sees it. */
    requestAnimationFrame(() => {
        const cards = document.querySelectorAll('.notice-slot-card');
        const lastCard = cards[cards.length - 1];
        if (lastCard) lastCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
};

window.triggerNoticeSlotUpload = function(index) {
    pendingNoticeFileEditIndex = index;
    document.getElementById("notice-item-file-shared").click();
};

window.removeNoticeSlotImage = async function(index) {
    const slot = noticeSlots[index];
    if (!slot) return;
    const confirmed = await customConfirm("Remove Image", "Reset this notice's image to the default placeholder? Click SAVE afterwards to publish the change.", "danger");
    if (!confirmed) return;
    noticePendingImageEdits[index] = TRANSPARENT_PIXEL_GIF;
    buildNoticeSlotsUI();
    pulseEditedThenUnsaved(`notice-slot-status-${index}`);
};

/* STATE GUARDRAIL: removing a slot only ever operates on its own array index --
   it never mutates, re-keys, or regenerates any other slot's data. "saved" slots
   (already published) are also deleted from Firestore on confirm; "draft" slots
   (never yet saved) are simply dropped from local memory with no network write. */
window.removeNoticeSlot = async function(index) {
    const slot = noticeSlots[index];
    if (!slot) return;
    /* PERSISTENT DEFAULT SLOT: the Notice Edit section must never be left completely
       empty, so the last remaining card can never be removed. */
    if (noticeSlots.length <= 1) {
        await customAlert("Action Blocked", "At least one notice slot must always remain. Add another slot before removing this one.", "error");
        return;
    }
    const confirmed = await customConfirm("Remove Notice", "Delete this notice slot? This cannot be undone.", "danger");
    if (!confirmed) return;

    if (slot.saved && slot.firestoreIndex !== null && window.FirebaseBridge) {
        const { db, doc, setDoc } = window.FirebaseBridge;
        const items = activeNoticeItems.filter((_, i) => i !== slot.firestoreIndex);
        try {
            await setDoc(doc(db, "configuration", "notice"), { items, lastModified: new Date().getTime() }, { merge: true });
            await customAlert("Deleted", "Notice removed.", "success");
        } catch (err) {
            await customAlert("Error", "Failed to delete notice.", "error");
            return;
        }
        /* activeNoticeItems / noticeSlots will be rebuilt fresh by the live onSnapshot
           listener once the write above lands, so no manual splice is needed here. */
    } else {
        noticeSlots.splice(index, 1);
        /* Re-key every staged image sitting above the removed slot down by one so each
           still tracks the same card after the splice (deleting only [index] left the
           later entries pointing at the wrong, shifted-down slots). */
        const remapped = {};
        Object.keys(noticePendingImageEdits).forEach(k => {
            const i = Number(k);
            if (i < index) remapped[i] = noticePendingImageEdits[k];
            else if (i > index) remapped[i - 1] = noticePendingImageEdits[k];
        });
        noticePendingImageEdits = remapped;
        buildNoticeSlotsUI();
    }
};

window.saveNoticeSlotEdit = async function(index) {
    const slot = noticeSlots[index];
    if (!slot) return;
    const capInput = document.getElementById(`notice-slot-cap-${index}`);
    const finalCaption = capInput ? capInput.value.trim() : (slot.caption || "");
    const finalImageUrl = noticePendingImageEdits[index] || slot.imageUrl;

    if (!finalImageUrl || isPlaceholderMediaUrl(finalImageUrl)) {
        await customAlert("Missing Image", "Please add an image before saving this notice.", "error");
        return;
    }
    if (!window.FirebaseBridge) return;
    const { db, doc, setDoc } = window.FirebaseBridge;

    const items = activeNoticeItems.map(it => ({ ...it }));
    if (slot.saved && slot.firestoreIndex !== null) {
        items[slot.firestoreIndex] = { imageUrl: finalImageUrl, caption: finalCaption };
    } else {
        items.push({ imageUrl: finalImageUrl, caption: finalCaption });
    }

    try {
        await setDoc(doc(db, "configuration", "notice"), { items, lastModified: new Date().getTime() }, { merge: true });
        delete noticePendingImageEdits[index];
        /* GLITCH FIX: promote this exact slot to "saved" (with its correct firestoreIndex)
           right now instead of waiting on the async onSnapshot echo. Previously the slot
           stayed flagged saved:false in local memory until that listener callback ran, so
           when it did fire, the rebuild's draftSlots filter still matched this very slot as
           an unsaved draft and re-appended it a second time underneath the now-saved card --
           this was the "new unwanted section slot" glitch. Updating the flag immediately
           keeps noticeSlots and the live Firestore data in sync with no duplicate window. */
        const savedIndex = (slot.saved && slot.firestoreIndex !== null) ? slot.firestoreIndex : items.length - 1;
        slot.saved = true;
        slot.firestoreIndex = savedIndex;
        slot.imageUrl = finalImageUrl;
        slot.caption = finalCaption;
        flashSavedStatus(`notice-slot-status-${index}`);
        await customAlert("Success", "Notice updated. It is now live on the main website.", "success");
        /* activeNoticeItems / noticeSlots still refresh from the live onSnapshot listener
           once this write lands -- that now simply confirms the state set above instead of
           needing to be the sole source of truth for the promotion. */
    } catch (err) {
        await customAlert("Error", "Failed to sync notice data.", "error");
    }
};

window.selectCreatorRatio = function(ratio) {
    selectedCreatorRatio = ratio;
    document.querySelectorAll('#creator-ratio-row .ratio-toggle-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-ratio') === ratio);
    });
    applyCreatorRatioIndicator(ratio);
    if (ratio !== savedCreatorRatio) pulseEditedThenUnsaved('creator-status-indicator');
};

/* Dynamic aspect-ratio indicator for the Creator Icon live preview: a strict 1:1 frame
   with a subtle boundary mask when 1:1 is active, and a bright blue outline stroke
   around the canvas perimeter for any other selected ratio (16:9, 3:4, etc). */
function applyCreatorRatioIndicator(ratio) {
    const frame = document.getElementById('creator-preview-frame');
    if (!frame) return;
    frame.style.aspectRatio = ratio || '1 / 1';
    const isSquare = !ratio || ratio === '1/1';
    frame.classList.toggle('ratio-square', isSquare);
    frame.classList.add('ratio-outline');

    /* The "USED" badge marks the ratio that is actually saved/applied on the server --
       not merely the tab currently being previewed. Tapping a different ratio tab
       only stages a preview; the badge must stay tied to savedCreatorRatio and hide
       the instant the previewed ratio no longer matches what's actually live, only
       reappearing once that same ratio is saved (or already was the live one). */
    const usedBadge = document.getElementById('creator-ratio-used-badge');
    if (usedBadge) usedBadge.classList.toggle('hidden', !ratio || ratio !== savedCreatorRatio);
}

window.saveCreatorIconData = async function() {
    if (!window.FirebaseBridge) return;
    const { db, doc, setDoc } = window.FirebaseBridge;
    const previewImg = document.getElementById("admin-creator-preview-img");
    const finalImageUrl = previewImg.getAttribute("data-new-url") || previewImg.src;

    try {
        const payload = {
            imageUrl: finalImageUrl,
            lastModified: new Date().getTime()
        };
        if (selectedCreatorRatio) payload.aspectRatio = selectedCreatorRatio;

        await setDoc(doc(db, "configuration", "creatorIcon"), payload, { merge: true });

        previewImg.removeAttribute("data-new-url");
        if (selectedCreatorRatio) {
            savedCreatorRatio = selectedCreatorRatio;
            applyCreatorRatioIndicator(selectedCreatorRatio);
        }
        flashSavedStatus('creator-status-indicator');
        await customAlert("Success", "Creator icon updated successfully.", "success");
    } catch (err) {
        await customAlert("Error", "Failed to sync creator icon.", "error");
    }
}
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
            switchPrizeSubTab("latest");
            initializeRealtimePrizeConfigStreams();
        } else {
            window.location.replace("../index.html");
        }
    });
} else {
    window.location.replace("../index.html");
}
