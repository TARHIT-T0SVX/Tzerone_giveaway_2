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

/* Firestore hard-caps a single writeBatch at 500 operations. Every "ALL"-type bulk
   action routes through this helper so datasets past 500 records commit correctly
   in sequential 500-op chunks instead of throwing on batch.commit(). */
async function commitInChunks(db, writeBatch, items, applyOp, chunkSize) {
    /* `chunkSize` is the number of ITEMS per batch, not operations. Callers whose applyOp
       issues more than one write per item (e.g. deleting an entry plus its private contact
       doc) must pass a smaller value so items x writes-per-item stays under Firestore's
       hard 500-operation cap. Defaults to 500 for the one-write-per-item case. */
    const CHUNK = chunkSize || 500;
    for (let i = 0; i < items.length; i += CHUNK) {
        const batch = writeBatch(db);
        items.slice(i, i + CHUNK).forEach(item => applyOp(batch, item));
        await batch.commit();
    }
}

window.copyToClipboardText = function(text) {
    const announceSuccess = () => customAlert("Copied", "Copied to clipboard.", "success");
    const announceFailure = () => customAlert("Error", "Failed to copy.", "error");

    /* Primary path: async Clipboard API (requires a secure/HTTPS context). */
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(announceSuccess).catch(() => legacyCopyFallback(text, announceSuccess, announceFailure));
        return;
    }
    /* Fallback for non-secure contexts or older embedded webviews where the
       Clipboard API is unavailable: a hidden, selected textarea + execCommand. */
    legacyCopyFallback(text, announceSuccess, announceFailure);
};

function legacyCopyFallback(text, onSuccess, onFailure) {
    try {
        const tempInput = document.createElement("textarea");
        tempInput.value = text;
        tempInput.style.position = "fixed";
        tempInput.style.opacity = "0";
        tempInput.style.left = "-9999px";
        document.body.appendChild(tempInput);
        tempInput.focus();
        tempInput.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(tempInput);
        ok ? onSuccess() : onFailure();
    } catch (e) {
        onFailure();
    }
}

/* System-wide clipboard copy fix: every copy-enabled element (Winner History / Normal
   History tables — phone numbers, registration text, Game ID strings) carries a
   data-copy-value attribute. A single delegated listener binds every one of them to
   window.copyToClipboardText(text), so copy buttons work reliably on every row,
   including values containing quotes, ampersands, or other special characters that
   used to break inline onclick handlers. */
document.addEventListener("click", function(evt) {
    const trigger = evt.target.closest("[data-copy-value]");
    if (!trigger) return;
    const decoder = document.createElement("textarea");
    decoder.innerHTML = trigger.getAttribute("data-copy-value") || "";
    window.copyToClipboardText(decoder.value);
});
/* =====================================================================
   GLOBAL STATE
===================================================================== */
let activeSubmissionsSnapshot = [];
let activeArchiveWinnerSnapshot = [];
let activeDisqualifiedSnapshot = [];
let activeRemovedSnapshot = [];
let activeWinnerHistorySnapshot = [];
let activeNormalHistorySnapshot = [];

let currentArchiveTab = 'winner';
let currentHistoryTab = 'winner';
let countdownInterval = null;

/* =====================================================================
   PRIVATE CONTACT JOIN
   Phone number and age no longer live on the submissions document, because that
   document must stay publicly readable for the Main Website's dashboard and its
   duplicate-Game-ID check — and Firestore cannot hide a single field from a reader
   who is allowed to read the document at all. They now live in
   submission_contacts/{id}, which only an allowlisted admin can read, keyed by the
   SAME document id as the entry.

   This map is the live join: id -> { phoneNumber, age }. Every place the panel
   displays contact details goes through resolveContact() below, which prefers the
   private record and falls back to the legacy inline fields so entries created
   before the split keep rendering exactly as they always did.
===================================================================== */
let submissionContactsMap = Object.create(null);

function resolveContact(item) {
    if (!item) return { phoneNumber: "", age: "" };
    const priv = submissionContactsMap[item.id];
    return {
        // `?? ""` rather than `|| ""` for age: an age of 0 is falsy but is still a value
        // the admin should see rather than have silently replaced by the legacy field.
        phoneNumber: (priv && priv.phoneNumber) || item.phoneNumber || "",
        age: (priv && priv.age !== undefined && priv.age !== null) ? priv.age : (item.age ?? "")
    };
}

function initializeRealtimeContactStreams() {
    if (!window.FirebaseBridge) return;
    const { db, collection, query, onSnapshot } = window.FirebaseBridge;

    onSnapshot(query(collection(db, "submission_contacts")), (querySnapshot) => {
        const next = Object.create(null);
        querySnapshot.forEach(docSnap => { next[docSnap.id] = docSnap.data(); });
        submissionContactsMap = next;
        // Contact details are rendered inside these two lists, so both must repaint
        // once the private half arrives (it can land after the public half).
        buildApprovalListUI();
        buildArchiveListUI();
    }, (error) => {
        console.error("submission_contacts stream error:", error);
    });
}

/* Deleting an entry for good must take its private contact record with it, otherwise
   the phone number is orphaned in Firestore forever with nothing referencing it.
   Missing/already-deleted contact docs are ignored — delete on a nonexistent doc is a
   no-op in Firestore, so this is safe for legacy entries that never had one. */
async function deleteContactRecord(submissionId) {
    if (!window.FirebaseBridge) return;
    const { db, doc, deleteDoc } = window.FirebaseBridge;
    try { await deleteDoc(doc(db, "submission_contacts", submissionId)); } catch (e) { /* nothing to remove */ }
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
/* =====================================================================
   LOGIN
===================================================================== */
window.togglePasswordVisibility = function() {
    const pwd = document.getElementById("auth-password");
    const iconOpen = document.getElementById("eye-icon-open");
    const iconClosed = document.getElementById("eye-icon-closed");
    if(pwd.type === "password") {
        pwd.type = "text";
        iconClosed.classList.add("hidden");
        iconOpen.classList.remove("hidden");
    } else {
        pwd.type = "password";
        iconOpen.classList.add("hidden");
        iconClosed.classList.remove("hidden");
    }
}

window.verifyAdminGatewayCredentials = async function() {
    const email = document.getElementById("auth-email").value.trim();
    const pass = document.getElementById("auth-password").value;

    if (!window.FirebaseBridge || !window.FirebaseBridge.auth) return;

    try {
        await window.FirebaseBridge.setPersistence(window.FirebaseBridge.auth, window.FirebaseBridge.browserSessionPersistence);
        await window.FirebaseBridge.signInWithEmailAndPassword(window.FirebaseBridge.auth, email, pass);
        /* The onAuthStateChanged listener below picks up the freshly-signed-in user
           and reveals the dashboard -- no need to duplicate that logic here. */
    } catch (error) {
        await customAlert("ACCESS DENIED", "INVALID GATEWAY AUTHORIZATION SIGNATURE.", "error");
    }
}

/* =====================================================================
   SESSION GATE
   The login screen only ever has a chance to appear here, on index.html.
   Firebase's persisted session (browserSessionPersistence) is checked the
   instant this page loads; if a session already exists the dashboard is
   revealed straight away with no login flash. The Edit and Prize pages
   run the same check and silently redirect back here if no session is
   found -- they never render a login form of their own.
===================================================================== */
function revealHomeDashboard() {
    document.getElementById("admin-auth-overlay").classList.add("hidden");
    document.getElementById("admin-panel-view").classList.remove("hidden");
    document.documentElement.classList.remove("session-checking");

    showHomeSection("approval");
    switchArchiveSubTab("winner");
    switchHistorySubTab("winner");

    initializeRealtimeEventStream();
    initializeRealtimeSubmissionDataStreams();
    initializeRealtimeContactStreams();
    initializeRealtimeWinnerHistoryStreams();
    initializeRealtimeNormalHistoryStreams();
    initializeRealtimeNoticesStreams();
}

if (window.FirebaseBridge && window.FirebaseBridge.auth) {
    window.FirebaseBridge.onAuthStateChanged(window.FirebaseBridge.auth, (user) => {
        if (user) {
            revealHomeDashboard();
        } else {
            document.getElementById("admin-panel-view").classList.add("hidden");
            document.getElementById("admin-auth-overlay").classList.remove("hidden");
            document.documentElement.classList.remove("session-checking");
        }
    });
} else {
    document.documentElement.classList.remove("session-checking");
}
/* =====================================================================
   NAVIGATION (in-page sections: Approval / Event / Archive / History / Notices)
===================================================================== */
window.showHomeSection = function(sectionName) {
    document.querySelectorAll(".home-section").forEach(el => el.classList.remove("active"));
    document.querySelectorAll(".grid-nav-btn").forEach(el => el.classList.remove("active"));
    document.getElementById(`section-${sectionName}`).classList.add("active");
    document.getElementById(`grid-btn-${sectionName}`).classList.add("active");
}

window.switchArchiveSubTab = function(tabName) {
    currentArchiveTab = tabName;
    document.querySelectorAll("#archive-segmented-tabs .segment-btn").forEach(btn => btn.classList.remove("active"));
    const idx = { winner: 0, disqualified: 1, removed: 2 }[tabName];
    document.querySelectorAll("#archive-segmented-tabs .segment-btn")[idx].classList.add("active");
    buildArchiveListUI();
}

window.switchHistorySubTab = function(tabName) {
    currentHistoryTab = tabName;
    document.querySelectorAll("#history-segmented-tabs .segment-btn").forEach(btn => btn.classList.remove("active"));
    const idx = { winner: 0, normal: 1 }[tabName];
    document.querySelectorAll("#history-segmented-tabs .segment-btn")[idx].classList.add("active");
    buildHistoryListUI();
}
/* =====================================================================
   FIRESTORE REALTIME STREAM: EVENT STATUS / COUNTDOWN
===================================================================== */
function initializeRealtimeEventStream() {
    if (!window.FirebaseBridge) return;
    const { db, doc, onSnapshot } = window.FirebaseBridge;

    onSnapshot(doc(db, "configuration", "event"), (docSnapshot) => {
        let liveEventStatus = "open";
        let endsAt = null;
        if(docSnapshot.exists()) {
            const d = docSnapshot.data();
            if(d.status) liveEventStatus = d.status;
            if(d.endsAt) endsAt = d.endsAt;
        }

        const statusText = document.getElementById("active-status-text");
        const statusDot = document.getElementById("active-status-dot");
        if(statusText && statusDot) {
            if(liveEventStatus === "closed") {
                statusText.innerText = "ACTIVE STATUS: STOPPED";
                statusDot.classList.add("closed");
            } else {
                statusText.innerText = "ACTIVE STATUS: OPEN";
                statusDot.classList.remove("closed");
            }
        }

        startLiveCountdown(endsAt);
    });
}
function initializeRealtimeSubmissionDataStreams() {
    if (!window.FirebaseBridge) return;
    const { db, collection, query, onSnapshot } = window.FirebaseBridge;

    onSnapshot(query(collection(db, "submissions")), (querySnapshot) => {
        activeSubmissionsSnapshot = [];
        activeArchiveWinnerSnapshot = [];
        activeDisqualifiedSnapshot = [];
        activeRemovedSnapshot = [];

        querySnapshot.forEach(docSnap => {
            const d = docSnap.data();
            const item = { id: docSnap.id, ...d };
            if(d.status === "archived") activeArchiveWinnerSnapshot.push(item);
            else if(d.status === "disqualified") activeDisqualifiedSnapshot.push(item);
            else if(d.status === "removed") activeRemovedSnapshot.push(item);
            else activeSubmissionsSnapshot.push(item);
        });

        const byTime = (x, y) => (y.timestamp || 0) - (x.timestamp || 0);
        activeSubmissionsSnapshot.sort(byTime);
        activeArchiveWinnerSnapshot.sort(byTime);
        activeDisqualifiedSnapshot.sort(byTime);
        activeRemovedSnapshot.sort(byTime);

        buildApprovalListUI();
        buildArchiveListUI();
    });
}

/* winnerHistory is PUBLIC (it powers the Main Website's winners board), so it can no
   longer carry a phone number. The contact detail for each win now lives only in the
   admin-only winners_log. This map is the join: gameId -> phone, so the Winner History
   table and the exports below still show the number to the admin and only the admin.
   Legacy winnerHistory records that still have an inline phoneNumber keep working via
   the fallback in resolveWinnerPhone(). */
let winnersLogPhoneByGameId = Object.create(null);

function resolveWinnerPhone(winnerRecord) {
    if (!winnerRecord) return "";
    const fromLog = winnersLogPhoneByGameId[winnerRecord.gameId];
    return fromLog || winnerRecord.phoneNumber || winnerRecord.phone || "";
}

function initializeRealtimeWinnerHistoryStreams() {
    if (!window.FirebaseBridge) return;
    const { db, collection, query, onSnapshot } = window.FirebaseBridge;

    onSnapshot(query(collection(db, "winnerHistory")), (querySnapshot) => {
        activeWinnerHistorySnapshot = [];
        querySnapshot.forEach(docSnap => { activeWinnerHistorySnapshot.push({ id: docSnap.id, ...docSnap.data() }); });
        activeWinnerHistorySnapshot.sort((x, y) => (y.wonAt || 0) - (x.wonAt || 0));
        buildHistoryListUI();
    });

    onSnapshot(query(collection(db, "winners_log")), (querySnapshot) => {
        const next = Object.create(null);
        const entries = [];
        querySnapshot.forEach(docSnap => entries.push(docSnap.data()));
        // Sorted oldest-first so that when a Game ID has won more than once, the most
        // recent confirmed number is what ends up in the map.
        entries.sort((x, y) => (x.confirmedAt || 0) - (y.confirmedAt || 0));
        entries.forEach(d => { if (d.gameId && d.phone) next[d.gameId] = d.phone; });
        winnersLogPhoneByGameId = next;
        buildHistoryListUI();
    }, (error) => {
        console.error("winners_log stream error:", error);
    });
}

function initializeRealtimeNormalHistoryStreams() {
    if (!window.FirebaseBridge) return;
    const { db, collection, query, onSnapshot } = window.FirebaseBridge;

    onSnapshot(query(collection(db, "historyLog")), (querySnapshot) => {
        activeNormalHistorySnapshot = [];
        querySnapshot.forEach(docSnap => { activeNormalHistorySnapshot.push({ id: docSnap.id, ...docSnap.data() }); });
        activeNormalHistorySnapshot.sort((x, y) => (y.timestamp || 0) - (x.timestamp || 0));
        buildHistoryListUI();
    });
}

async function logToNormalHistory(item, action) {
    if (!window.FirebaseBridge) return;
    const { db, collection, addDoc } = window.FirebaseBridge;
    try {
        // historyLog is an admin-only collection, so it is a legitimate place to keep the
        // phone number for the audit trail — but it must be resolved through the private
        // contact join now, not read off the (public) submission document.
        await addDoc(collection(db, "historyLog"), {
            name: item.name || "",
            gameId: item.gameId || "",
            phoneNumber: resolveContact(item).phoneNumber,
            action: action,
            timestamp: new Date().getTime()
        });
    } catch (err) { console.error(err); }
}
function buildApprovalListUI() {
    const box = document.getElementById("approval-list-box");
    if (!box) return;

    if (activeSubmissionsSnapshot.length === 0) {
        box.innerHTML = `<tr><td colspan="6"><div class="empty-state-text">No submissions found.</div></td></tr>`;
        return;
    }

    let html = "";
    activeSubmissionsSnapshot.forEach(item => {
        const badgeClass = item.status === "approved" ? "status-badge approved" : "status-badge pending";
        const contact = resolveContact(item);
        html += `
            <tr>
                <td data-label="Name">${escapeHtml(item.name)}</td>
                <td data-label="Age">${escapeHtml(contact.age === "" ? '-' : contact.age)}</td>
                <td data-label="Phone Number">${escapeHtml(contact.phoneNumber)}</td>
                <td data-label="Game ID">${escapeHtml(item.gameId)}</td>
                <td data-label="Status"><span class="${badgeClass}">${escapeHtml((item.status || 'pending').toUpperCase())}</span></td>
                <td data-label="Actions">
                    <div class="player-card-actions">
                        ${item.status !== 'approved' ? `<button class="circle-action-btn approve-check" title="Approve" onclick="approveSubmission('${item.id}')"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></button>` : ''}
                        <button class="circle-action-btn reject-cross" title="Delete" onclick="softRemoveSubmission('${item.id}')"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>
                        <button class="circle-action-btn disqualify-btn" title="Disqualify" onclick="disqualifySubmission('${item.id}')"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8 0-1.85.63-3.55 1.69-4.9L16.9 18.31C15.55 19.37 13.85 20 12 20zm6.31-3.1L7.1 5.69C8.45 4.63 10.15 4 12 4c4.41 0 8 3.59 8 8 0 1.85-.63 3.55-1.69 4.9z"/></svg></button>
                    </div>
                </td>
            </tr>`;
    });
    box.innerHTML = html;
}

window.approveSubmission = async function(documentId) {
    if (!window.FirebaseBridge) return;
    const { db, doc, updateDoc } = window.FirebaseBridge;
    const item = activeSubmissionsSnapshot.find(x => x.id === documentId);
    try {
        await updateDoc(doc(db, "submissions", documentId), { status: "approved" });
        if (item) logToNormalHistory(item, "approved");
    } catch (err) { console.error(err); }
}

window.softRemoveSubmission = async function(documentId) {
    const isConfirmed = await customConfirm("Remove Entry", "Move this player to the Removed page?", "error");
    if (!isConfirmed) return;
    if (!window.FirebaseBridge) return;
    const { db, doc, updateDoc } = window.FirebaseBridge;
    const item = activeSubmissionsSnapshot.find(x => x.id === documentId);
    try {
        await updateDoc(doc(db, "submissions", documentId), { status: "removed" });
        if (item) logToNormalHistory(item, "removed");
    } catch (err) { console.error(err); }
}

window.disqualifySubmission = async function(documentId) {
    const isConfirmed = await customConfirm("Disqualify Player", "Move this player to the Disqualified page?", "warning");
    if (!isConfirmed) return;
    if (!window.FirebaseBridge) return;
    const { db, doc, updateDoc } = window.FirebaseBridge;
    const item = activeSubmissionsSnapshot.find(x => x.id === documentId);
    try {
        await updateDoc(doc(db, "submissions", documentId), { status: "disqualified" });
        if (item) logToNormalHistory(item, "disqualified");
    } catch (err) { console.error(err); }
}

window.acceptAllApprovals = async function() {
    const isConfirmed = await customConfirm("Approve All", "Are you sure you want to approve ALL pending submissions?", "success");
    if (!isConfirmed) return;
    if (!window.FirebaseBridge) return;

    const { db, doc, writeBatch } = window.FirebaseBridge;
    const pendingRecords = activeSubmissionsSnapshot.filter(item => item.status === "pending");
    if (pendingRecords.length === 0) {
        await customAlert("Empty", "No pending submissions to approve.", "info");
        return;
    }
    try {
        await commitInChunks(db, writeBatch, pendingRecords, (batch, item) => batch.update(doc(db, "submissions", item.id), { status: "approved" }));
        pendingRecords.forEach(item => logToNormalHistory(item, "approved"));
        await customAlert("Success", "All pending records have been successfully approved.", "success");
    } catch (err) { await customAlert("Error", "Error while processing batch approval.", "error"); }
}

window.wipeAllSubmissionsSeason = async function() {
    const isConfirmed = await customConfirm("Remove All", "Move ALL current entries to the Removed page?", "error");
    if (!isConfirmed) return;
    if (!window.FirebaseBridge) return;

    const { db, doc, writeBatch } = window.FirebaseBridge;
    if (activeSubmissionsSnapshot.length === 0) {
        await customAlert("Empty", "No submissions to remove.", "info");
        return;
    }
    try {
        await commitInChunks(db, writeBatch, activeSubmissionsSnapshot, (batch, item) => batch.update(doc(db, "submissions", item.id), { status: "removed" }));
        activeSubmissionsSnapshot.forEach(item => logToNormalHistory(item, "removed"));
        await customAlert("Done", "All entries moved to the Removed page.", "success");
    } catch (err) { await customAlert("Failure", "Batch execution failure.", "error"); }
}

/* =====================================================================
   ARCHIVE FOLDER (ID / Phone split onto separate lines)
===================================================================== */
function buildArchiveListUI() {
    const box = document.getElementById("archive-list-box");
    if (!box) return;

    let dataset = [];
    if (currentArchiveTab === 'winner') dataset = activeArchiveWinnerSnapshot;
    else if (currentArchiveTab === 'disqualified') dataset = activeDisqualifiedSnapshot;
    else dataset = activeRemovedSnapshot;

    if (dataset.length === 0) {
        box.innerHTML = `<div class="empty-state-text">No records found.</div>`;
        return;
    }

    let html = "";
    dataset.forEach(item => {
        let actionsHtml = "";
        if (currentArchiveTab === 'winner') {
            actionsHtml = `
                <button class="circle-action-btn approve-check" title="Send Back to Pending" onclick="sendWinnerBackToApproval('${item.id}')"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg></button>
                <button class="circle-action-btn reject-cross" title="Delete" onclick="archiveMoveToRemoved('${item.id}')"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>`;
        } else {
            actionsHtml = `
                <button class="circle-action-btn reject-cross" title="${currentArchiveTab === 'removed' ? 'Delete Permanently' : 'Remove'}" onclick="${currentArchiveTab === 'removed' ? `permanentlyDeleteSubmission('${item.id}')` : `archiveMoveToRemoved('${item.id}')`}"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>
                <button class="circle-action-btn approve-check" title="Return to Approval Board" onclick="returnToApprovalBoard('${item.id}')"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg></button>`;
        }

        html += `
            <div class="player-card">
                <div class="player-card-info">
                    <span class="player-card-name">${escapeHtml(item.name)}</span>
                    <span class="player-card-meta">ID: ${escapeHtml(item.gameId)}</span>
                    <span class="player-card-meta">Phone: ${escapeHtml(resolveContact(item).phoneNumber)}</span>
                </div>
                <div class="player-card-actions">${actionsHtml}</div>
            </div>`;
    });
    box.innerHTML = html;
}

/* ARCHIVE → WINNER BACK-TRACK WORKFLOW
   "Disqualify / Send Back to Pending": a player who was drawn as a winner (their
   submission sits at status "archived", and a matching record exists in
   winnerHistory) is safely rolled all the way back:
     1. Every winnerHistory record matching this player's Game ID is deleted, so
        they no longer appear on the Main Website's public Winners list.
     2. Their submission transitions back to "pending", dropping them into the
        active Approval Board queue so they can be approved and re-enter the
        Lucky Draw pool again.
     3. The action is written to the normal history log for auditing. */
window.sendWinnerBackToApproval = async function(documentId) {
    const isConfirmed = await customConfirm(
        "Send Back to Pending",
        "Remove this player from Winner History and return them to the Approval Board? They will be eligible for the Lucky Draw again.",
        "warning"
    );
    if (!isConfirmed) return;
    if (!window.FirebaseBridge) return;
    const { db, doc, updateDoc, deleteDoc } = window.FirebaseBridge;
    const item = activeArchiveWinnerSnapshot.find(x => x.id === documentId);
    if (!item) return;

    try {
        /* Purge any winnerHistory record(s) for this player, matched by Game ID
           (the stable identity shared across all three apps). Guards against a
           player somehow having more than one winner record. */
        const matches = activeWinnerHistorySnapshot.filter(
            w => w.gameId && item.gameId && w.gameId === item.gameId
        );
        for (const w of matches) {
            await deleteDoc(doc(db, "winnerHistory", w.id));
        }

        /* Route the submission back into the live Approval Board queue. */
        await updateDoc(doc(db, "submissions", documentId), { status: "pending" });
        logToNormalHistory(item, "disqualified");

        await customAlert(
            "Sent to Approval Board",
            "Player removed from Winner History and returned to the Approval Board.",
            "success"
        );
    } catch (err) {
        await customAlert("Error", "Failed to send this player back to the Approval Board.", "error");
    }
}

/* Backward-compatible alias so any older cached markup still calling the previous
   function name continues to work. */
window.confirmArchiveWinner = window.sendWinnerBackToApproval;

window.archiveMoveToRemoved = async function(documentId) {
    const isConfirmed = await customConfirm("Remove Entry", "Move this player to the Removed page?", "error");
    if (!isConfirmed) return;
    if (!window.FirebaseBridge) return;
    const { db, doc, updateDoc } = window.FirebaseBridge;
    const item = [...activeArchiveWinnerSnapshot, ...activeDisqualifiedSnapshot].find(x => x.id === documentId);
    try {
        await updateDoc(doc(db, "submissions", documentId), { status: "removed" });
        if (item) logToNormalHistory(item, "removed");
    } catch (err) { console.error(err); }
}

window.returnToApprovalBoard = async function(documentId) {
    if (!window.FirebaseBridge) return;
    const { db, doc, updateDoc } = window.FirebaseBridge;
    try { await updateDoc(doc(db, "submissions", documentId), { status: "pending" }); } catch (err) { console.error(err); }
}

window.permanentlyDeleteSubmission = async function(documentId) {
    const isConfirmed = await customConfirm("Permanent Deletion", "Permanently erase this record from the database?", "error");
    if (!isConfirmed) return;
    if (!window.FirebaseBridge) return;
    const { db, doc, deleteDoc } = window.FirebaseBridge;
    try {
        await deleteDoc(doc(db, "submissions", documentId));
        // Take the private contact record with it — otherwise the phone number is left
        // orphaned in Firestore with no entry pointing at it.
        await deleteContactRecord(documentId);
    } catch (err) { console.error(err); }
}

window.archiveApproveAll = async function() {
    const isConfirmed = await customConfirm("Approve All", "Return ALL players in this tab to the Approval Board?", "success");
    if (!isConfirmed) return;
    if (!window.FirebaseBridge) return;

    if (currentArchiveTab === 'winner') {
        /* Standardized behavior: APPROVE ALL in the Winner tab must act exactly like the
           individual green checkmark ("Send Back to Pending") action, looped across every
           player currently in view -- never route into the permanent Winner History. */
        if (activeArchiveWinnerSnapshot.length === 0) return customAlert("Empty", "Nothing to approve.", "info");
        const { db, doc, updateDoc, deleteDoc } = window.FirebaseBridge;
        try {
            for (const item of activeArchiveWinnerSnapshot) {
                /* Purge any matching winnerHistory record(s) by Game ID -- identical
                   duplicate-guard logic to sendWinnerBackToApproval -- so a bulk approve
                   never leaves a stale winner on the Main Website's public Winners list. */
                const matches = activeWinnerHistorySnapshot.filter(
                    w => w.gameId && item.gameId && w.gameId === item.gameId
                );
                for (const w of matches) {
                    await deleteDoc(doc(db, "winnerHistory", w.id));
                }
                await updateDoc(doc(db, "submissions", item.id), { status: "pending" });
                logToNormalHistory(item, "disqualified");
            }
            await customAlert("Success", "All players returned to the Approval Board.", "success");
        } catch (err) { await customAlert("Error", "Batch update failed.", "error"); }
        return;
    }

    /* DISQUALIFY / REMOVED tabs: bulk re-route their active dataset directly back
       into the Approval Board's pending queue, mirroring the individual green
       checkmark ("Return to Approval Board") action on each sub-tab. */
    const dataset = currentArchiveTab === 'disqualified' ? activeDisqualifiedSnapshot : activeRemovedSnapshot;
    if (dataset.length === 0) return customAlert("Empty", "Nothing to approve.", "info");
    const { db, doc, writeBatch } = window.FirebaseBridge;
    try {
        await commitInChunks(db, writeBatch, dataset, (batch, item) => batch.update(doc(db, "submissions", item.id), { status: "pending" }));
        await customAlert("Success", "All players returned to the Approval Board.", "success");
    } catch (err) { await customAlert("Error", "Batch update failed.", "error"); }
}

window.archiveRemoveAll = async function() {
    if (currentArchiveTab === 'removed') {
        const isConfirmed = await customConfirm("Permanent Deletion", "Permanently erase ALL records in the Removed page?", "error");
        if (!isConfirmed) return;
        if (!window.FirebaseBridge) return;
        if (activeRemovedSnapshot.length === 0) return customAlert("Empty", "Nothing to delete.", "info");
        const { db, doc, writeBatch } = window.FirebaseBridge;
        try {
            // Both halves of every entry go in the same batched delete, so a bulk purge
            // can never leave a pile of orphaned phone numbers behind. Each entry costs
            // two batch operations; commitInChunks caps a batch at 500 operations, so the
            // slice size is halved here to stay inside that limit.
            await commitInChunks(db, writeBatch, activeRemovedSnapshot, (batch, item) => {
                batch.delete(doc(db, "submissions", item.id));
                batch.delete(doc(db, "submission_contacts", item.id));
            }, 250);
            await customAlert("Done", "All removed records permanently deleted.", "success");
        } catch (err) { await customAlert("Error", "Batch deletion failed.", "error"); }
        return;
    }

    const isConfirmed = await customConfirm("Remove All", "Move ALL players in this tab to the Removed page?", "error");
    if (!isConfirmed) return;
    if (!window.FirebaseBridge) return;
    const dataset = currentArchiveTab === 'winner' ? activeArchiveWinnerSnapshot : activeDisqualifiedSnapshot;
    if (dataset.length === 0) return customAlert("Empty", "Nothing to remove.", "info");
    const { db, doc, writeBatch } = window.FirebaseBridge;
    try {
        await commitInChunks(db, writeBatch, dataset, (batch, item) => batch.update(doc(db, "submissions", item.id), { status: "removed" }));
        dataset.forEach(item => logToNormalHistory(item, "removed"));
        await customAlert("Done", "All players moved to the Removed page.", "success");
    } catch (err) { await customAlert("Error", "Batch update failed.", "error"); }
}
function buildCopyCellMarkup(value, isId = false) {
    const safeVal = escapeHtml(value || "");
    const highlightClass = isId ? "copy-highlight id-highlight" : "copy-highlight";
    return `<span class="copy-field-row">
                <span class="${highlightClass}">${safeVal}</span>
                <button class="circle-action-btn copy-btn" style="width:26px;height:26px;" title="Copy" data-copy-value="${safeVal}">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
                </button>
            </span>`;
}

function buildHistoryListUI() {
    const box = document.getElementById("history-list-box");
    if (!box) return;

    if (currentHistoryTab === 'winner') {
        if (activeWinnerHistorySnapshot.length === 0) {
            box.innerHTML = `<tr><td colspan="6"><div class="empty-state-text">No winners found.</div></td></tr>`;
            return;
        }
        let html = "";
        activeWinnerHistorySnapshot.forEach(item => {
            const dateStr = new Date(item.wonAt || Date.now()).toLocaleDateString();
            html += `
                <tr>
                    <td data-label="Name">${escapeHtml(item.name)}</td>
                    <td data-label="Game ID">${buildCopyCellMarkup(item.gameId, true)}</td>
                    <td data-label="Phone">${buildCopyCellMarkup(resolveWinnerPhone(item))}</td>
                    <td data-label="Status"><span class="status-badge winner-normal">WINNER</span></td>
                    <td data-label="Date"><span class="history-date-text">${dateStr}</span></td>
                    <td data-label="Actions"><button class="circle-action-btn winner-action-btn" title="Delete" onclick="removeWinnerHistoryRecord('${item.id}')"><svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button></td>
                </tr>`;
        });
        box.innerHTML = html;
        return;
    }

    if (activeNormalHistorySnapshot.length === 0) {
        box.innerHTML = `<tr><td colspan="6"><div class="empty-state-text">No history found.</div></td></tr>`;
        return;
    }
    let html = "";
    activeNormalHistorySnapshot.forEach(item => {
        const dateStr = new Date(item.timestamp || Date.now()).toLocaleDateString();
        const badgeClass = item.action === 'winner' ? 'winner-normal' : (item.action === 'removed' ? 'removed' : (item.action === 'disqualified' ? 'disqualified' : 'approved'));
        html += `
            <tr>
                <td data-label="Name">${escapeHtml(item.name)}</td>
                <td data-label="Game ID">${buildCopyCellMarkup(item.gameId, true)}</td>
                <td data-label="Phone">${buildCopyCellMarkup(item.phoneNumber)}</td>
                <td data-label="Status"><span class="status-badge ${badgeClass}">${escapeHtml((item.action || '').toUpperCase())}</span></td>
                <td data-label="Date"><span class="history-date-text">${dateStr}</span></td>
                <td data-label="Actions"><button class="circle-action-btn normal-action-danger" title="Delete" onclick="removeNormalHistoryRecord('${item.id}')"><svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button></td>
            </tr>`;
    });
    box.innerHTML = html;
}

window.removeWinnerHistoryRecord = async function(documentId) {
    const isConfirmed = await customConfirm("Delete History", "Permanently remove this past winner from the history logs?", "error");
    if (!isConfirmed) return;
    if (!window.FirebaseBridge) return;
    const { db, doc, deleteDoc } = window.FirebaseBridge;
    try { await deleteDoc(doc(db, "winnerHistory", documentId)); } catch (err) { await customAlert("Error", "Failed to delete this winner record.", "error"); }
}

window.removeNormalHistoryRecord = async function(documentId) {
    const isConfirmed = await customConfirm("Delete Log", "Permanently remove this log entry?", "error");
    if (!isConfirmed) return;
    if (!window.FirebaseBridge) return;
    const { db, doc, deleteDoc } = window.FirebaseBridge;
    try { await deleteDoc(doc(db, "historyLog", documentId)); } catch (err) { await customAlert("Error", "Failed to delete this log entry.", "error"); }
}

window.historyRemoveAll = async function() {
    const isConfirmed = await customConfirm("Delete All", `Permanently delete ALL entries in this log?`, "error");
    if (!isConfirmed) return;
    if (!window.FirebaseBridge) return;
    const { db, doc, writeBatch } = window.FirebaseBridge;

    const dataset = currentHistoryTab === 'winner' ? activeWinnerHistorySnapshot : activeNormalHistorySnapshot;
    const collectionName = currentHistoryTab === 'winner' ? 'winnerHistory' : 'historyLog';
    if (dataset.length === 0) return customAlert("Empty", "Nothing to delete.", "info");
    try {
        await commitInChunks(db, writeBatch, dataset, (batch, item) => batch.delete(doc(db, collectionName, item.id)));
        await customAlert("Done", "Log cleared.", "success");
    } catch (err) { await customAlert("Error", "Batch deletion failed.", "error"); }
}
window.openDownloadPopup = function() {
    document.getElementById("download-format-overlay").classList.remove("hidden");
}
window.closeDownloadPopup = function() {
    document.getElementById("download-format-overlay").classList.add("hidden");
}

window.confirmDownload = function(format) {
    closeDownloadPopup();
    if (format === 'txt') exportHistoryAsTxt();
    else exportHistoryAsPdf();
}

function exportHistoryAsTxt() {
    const onlyWinners = currentHistoryTab === 'winner';

    let str = "==================================================\n";
    str += "        ADMIN PANEL 1 - HISTORY EXPORT        \n";
    str += ` DATE: ${new Date().toISOString()} \n`;
    str += "==================================================\n\n";

    str += "----- WINNER HISTORY -----\n";
    if (activeWinnerHistorySnapshot.length === 0) str += "(none)\n";
    activeWinnerHistorySnapshot.forEach((item, idx) => {
        str += `${idx + 1}. NAME: ${item.name} | ID: ${item.gameId} | PHONE: ${resolveWinnerPhone(item)} | DATE: ${new Date(item.wonAt || Date.now()).toLocaleString()}\n`;
    });

    if (!onlyWinners) {
        str += "\n----- NORMAL HISTORY -----\n";
        if (activeNormalHistorySnapshot.length === 0) str += "(none)\n";
        activeNormalHistorySnapshot.forEach((item, idx) => {
            str += `${idx + 1}. NAME: ${item.name} | ID: ${item.gameId} | PHONE: ${item.phoneNumber} | ACTION: ${item.action} | DATE: ${new Date(item.timestamp || Date.now()).toLocaleString()}\n`;
        });
    }

    const blob = new Blob([str], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement("a");
    a.download = `ADMIN_PANEL_HISTORY_${new Date().getTime()}.txt`;
    a.href = window.URL.createObjectURL(blob);
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

async function exportHistoryAsPdf() {
    if (!window.jspdf) { customAlert("Error", "PDF engine failed to load.", "error"); return; }
    const onlyWinners = currentHistoryTab === 'winner';
    const { jsPDF } = window.jspdf;
    const docPdf = new jsPDF({ unit: "pt", format: "a4" });
    const pageWidth = docPdf.internal.pageSize.getWidth();
    const pageHeight = docPdf.internal.pageSize.getHeight();

    /* BRANDING ASSET: preload the official project logo once, up front, so every
       page header can stamp it top-right synchronously (no async gaps / white-screen
       flashes inside the render loop below). Non-fatal if it can't be fetched --
       the report still generates, just without the badge. */
    const LOGO_URL = "https://raw.githubusercontent.com/TARHIT-T0SVX/All-image-t-z/refs/heads/main/TZERONE_OFFICIAL_LOGO.png";
    let logoDataUrl = null, logoAspect = null;
    try {
        const resp = await fetch(LOGO_URL);
        const blob = await resp.blob();
        logoDataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
        const props = docPdf.getImageProperties(logoDataUrl);
        logoAspect = props.height / props.width;
    } catch (err) { logoDataUrl = null; }

    /* Strict 4-column grid, left-anchored so nothing overlaps or clips regardless
       of field length: NAME | GAME ID | DATE | STATUS (chip, always rightmost). */
    const tableLeft = 40, tableRight = pageWidth - 40;
    const colNameX = 48;
    const dividerX1 = 246;
    const colIdX = 254;
    const dividerX2 = 359;
    const colDateX = 367;
    const dividerX3 = 452;
    const colStatusRightX = tableRight - 8;
    const maxNameW = dividerX1 - colNameX - 6;
    const nameLineH = 11.5;

    let y = 50;

    const drawHeader = () => {
        docPdf.setFillColor(20, 20, 34);
        docPdf.rect(0, 0, pageWidth, 96, "F");
        docPdf.setFillColor(52, 199, 89);
        docPdf.rect(0, 94, pageWidth, 3, "F");
        docPdf.setTextColor(255, 255, 255);
        docPdf.setFont("helvetica", "bold");
        docPdf.setFontSize(23);
        docPdf.text("ADMIN PANEL 1", 40, 42);
        docPdf.setFontSize(12.5);
        docPdf.setTextColor(0, 242, 254);
        docPdf.text(onlyWinners ? "Winner History Report" : "Full History Report", 40, 62);
        docPdf.setFontSize(9.5);
        docPdf.setTextColor(180, 180, 195);
        docPdf.text(`Generated: ${new Date().toLocaleString()}`, 40, 80);

        /* TOP-RIGHT HEADER LOGO: capped to a max width AND a max height (whichever
           constrains first) while locked to the source PNG's native aspect ratio, so
           the transparent asset never stretches, distorts, or grows tall enough to
           clip into the green divider strip beneath the header. */
        if (logoDataUrl && logoAspect) {
            try {
                const maxBadgeW = 130;
                const maxBadgeH = 104;
                let badgeW = maxBadgeW;
                let badgeH = badgeW * logoAspect;
                if (badgeH > maxBadgeH) {
                    badgeH = maxBadgeH;
                    badgeW = badgeH / logoAspect;
                }
                const badgeX = pageWidth - 28 - badgeW;
                const badgeY = Math.max(0, (94 - badgeH) / 2 - 2);
                docPdf.addImage(logoDataUrl, "PNG", badgeX, badgeY, badgeW, badgeH);
            } catch (err) { /* Skip the badge silently if this asset can't be decoded. */ }
        }
    };

    const drawFooter = (pageNum) => {
        const footerCenterX = pageWidth / 2;

        /* Line 1: prominent, bold brand/copyright line. */
        docPdf.setFont("helvetica", "bold");
        docPdf.setFontSize(10);
        docPdf.setTextColor(55, 55, 70);
        docPdf.text("© T ZERONE", footerCenterX, pageHeight - 30, { align: "center" });

        /* Line 2: smaller, muted engagement line directly beneath line 1. */
        docPdf.setFont("helvetica", "normal");
        docPdf.setFontSize(7.5);
        docPdf.setTextColor(150, 150, 160);
        docPdf.text("Follow and subscribe for more unique contents", footerCenterX, pageHeight - 20, { align: "center" });

        docPdf.setFontSize(8);
        docPdf.setTextColor(150, 150, 160);
        docPdf.text(`Page ${pageNum}`, pageWidth - 40, pageHeight - 24, { align: "right" });
    };

    const drawColumnHeader = () => {
        docPdf.setFontSize(9);
        docPdf.setTextColor(120, 120, 130);
        docPdf.setFont("helvetica", "bold");
        docPdf.text("NAME", colNameX, y, { align: "left" });
        docPdf.text("GAME ID", colIdX, y, { align: "left" });
        docPdf.text("DATE", colDateX, y, { align: "left" });
        docPdf.text("STATUS", colStatusRightX, y, { align: "right" });
        y += 12;
        docPdf.setDrawColor(190, 193, 205);
        docPdf.setLineWidth(1);
        docPdf.line(tableLeft, y, tableRight, y);
        y += 16;
    };

    let pageNum = 1;
    drawHeader();
    drawFooter(pageNum);
    y = 130;

    const drawSectionHeader = (title) => {
        if (y > pageHeight - 90) { docPdf.addPage(); pageNum++; drawHeader(); drawFooter(pageNum); y = 130; }
        docPdf.setFillColor(52, 199, 89);
        docPdf.roundedRect(40, y - 18, pageWidth - 80, 28, 6, 6, "F");
        docPdf.setTextColor(255, 255, 255);
        docPdf.setFontSize(13);
        docPdf.setFont("helvetica", "bold");
        docPdf.text(title, 50, y);
        y += 32;
        drawColumnHeader();
    };

    /* Status → highlight color map. All statuses share one archetype -- a light,
       translucent fill with a matching border and colored text -- following the
       structure DISQUALIFIED originally used, each keeping its own color identity. */
    const STATUS_HIGHLIGHTS = {
        WINNER:       { fill: [255, 243, 205], border: [255, 209, 102], text: [153, 110, 0],  premium: true },
        REMOVED:      { fill: [255, 227, 224], border: [255, 176, 168], text: [200, 40, 30],  premium: true },
        APPROVED:     { fill: [223, 246, 231], border: [150, 220, 173], text: [30, 140, 70],  premium: true },
        DISQUALIFIED: { fill: [225, 240, 255], border: [153, 205, 255], text: [10, 132, 255], premium: true }
    };

    const ROW_MIN_H = 32;

    const drawRow = (idx, name, gameId, statusLabel, dateLine) => {
        /* Strict cell-boundary wrapping: long names break onto new lines inside
           their own cell instead of overflowing horizontally into Game ID. Row
           height grows to fit however many lines are needed. */
        docPdf.setFont("helvetica", "bold");
        docPdf.setFontSize(10);
        const nameLines = docPdf.splitTextToSize(String(name || "-"), maxNameW);
        const rowH = Math.max(ROW_MIN_H, nameLines.length * nameLineH + 16);

        if (y - 15 + rowH > pageHeight - 60) {
            docPdf.addPage(); pageNum++; drawHeader(); drawFooter(pageNum);
            y = 130; drawColumnHeader();
        }
        const rowTop = y - 15;
        const rowCenterY = rowTop + rowH / 2 + 3;

        /* Alternating row backgrounds: white / a subtle dark-tinted slate accent,
           each row boxed with a thin structural grid border and column dividers. */
        docPdf.setFillColor(idx % 2 === 0 ? 255 : 226, idx % 2 === 0 ? 255 : 229, idx % 2 === 0 ? 255 : 236);
        docPdf.rect(tableLeft, rowTop, tableRight - tableLeft, rowH, "F");
        docPdf.setDrawColor(215, 218, 228);
        docPdf.setLineWidth(0.6);
        docPdf.rect(tableLeft, rowTop, tableRight - tableLeft, rowH);
        [dividerX1, dividerX2, dividerX3].forEach(dx => {
            docPdf.line(dx, rowTop, dx, rowTop + rowH);
        });

        /* NAME — left-aligned, wrapped, vertically centered as a block within the cell. */
        docPdf.setTextColor(25, 25, 40);
        docPdf.setFont("helvetica", "bold");
        docPdf.setFontSize(10);
        const nameStartY = rowCenterY - ((nameLines.length - 1) * nameLineH) / 2;
        nameLines.forEach((line, i) => {
            docPdf.text(line, colNameX, nameStartY + i * nameLineH, { align: "left" });
        });

        /* GAME ID + DATE — left-aligned, single line, vertically centered on the row. */
        docPdf.setFont("helvetica", "normal");
        docPdf.setFontSize(9.5);
        docPdf.setTextColor(25, 25, 40);
        docPdf.text(gameId || "-", colIdX, rowCenterY, { align: "left" });
        docPdf.setFontSize(8.5);
        docPdf.setTextColor(110, 110, 122);
        docPdf.text(dateLine || "-", colDateX, rowCenterY, { align: "left" });

        /* STATUS — always the rightmost column. */
        const normalizedStatus = (statusLabel || "").toUpperCase().trim();
        const highlight = STATUS_HIGHLIGHTS[normalizedStatus];
        docPdf.setFont("helvetica", "bold");
        if (highlight) {
            /* Generously padded chip, sized from font metrics and vertically centered
               within the row so nothing ever clips or overflows, however long the
               status word is. */
            const chipFontSize = 8.5;
            docPdf.setFontSize(chipFontSize);
            const chipPadX = 9, chipPadY = 5;
            const ascent = chipFontSize * 0.72, descent = chipFontSize * 0.22;
            const textW = docPdf.getTextWidth(normalizedStatus);
            const chipW = Math.min(textW + chipPadX * 2, tableRight - dividerX3 - 6);
            const chipH = ascent + descent + chipPadY * 2;
            const chipX = colStatusRightX - chipW;
            const chipY = rowCenterY - ascent - chipPadY;

            docPdf.setFillColor(highlight.fill[0], highlight.fill[1], highlight.fill[2]);
            if (highlight.premium && highlight.border) {
                docPdf.setDrawColor(highlight.border[0], highlight.border[1], highlight.border[2]);
                docPdf.setLineWidth(0.9);
                docPdf.roundedRect(chipX, chipY, chipW, chipH, 4, 4, "FD");
            } else {
                docPdf.roundedRect(chipX, chipY, chipW, chipH, 4, 4, "F");
            }
            docPdf.setTextColor(highlight.text[0], highlight.text[1], highlight.text[2]);
            docPdf.text(normalizedStatus, colStatusRightX - chipPadX, rowCenterY, { align: "right" });
        } else {
            docPdf.setFontSize(9);
            docPdf.setTextColor(25, 25, 40);
            docPdf.text(normalizedStatus, colStatusRightX, rowCenterY, { align: "right" });
        }

        y += rowH;
    };

    if (onlyWinners) {
        /* Winner History tab: exclusively winner dataset */
        drawSectionHeader("Winner History");
        if (activeWinnerHistorySnapshot.length === 0) {
            docPdf.setTextColor(120, 120, 130); docPdf.setFontSize(10); docPdf.text("No winners recorded.", 48, y); y += 20;
        } else {
            activeWinnerHistorySnapshot.forEach((item, idx) => {
                drawRow(idx, item.name, item.gameId, "WINNER", new Date(item.wonAt || Date.now()).toLocaleDateString());
            });
        }
    } else {
        /* Normal History tab: all-inclusive report combining Winners, Disqualified, and Removed logs */
        const combined = [
            ...activeWinnerHistorySnapshot.map(item => ({ name: item.name, gameId: item.gameId, status: "WINNER", date: item.wonAt })),
            ...activeNormalHistorySnapshot
                .filter(item => item.action === 'disqualified' || item.action === 'removed')
                .map(item => ({ name: item.name, gameId: item.gameId, status: item.action, date: item.timestamp }))
        ].sort((a, b) => (b.date || 0) - (a.date || 0));

        drawSectionHeader("Full History — Winners, Disqualified & Removed");
        if (combined.length === 0) {
            docPdf.setTextColor(120, 120, 130); docPdf.setFontSize(10); docPdf.text("No records found.", 48, y); y += 20;
        } else {
            combined.forEach((item, idx) => {
                drawRow(idx, item.name, item.gameId, item.status, new Date(item.date || Date.now()).toLocaleDateString());
            });
        }
    }

    docPdf.save(`ADMIN_PANEL_HISTORY_${new Date().getTime()}.pdf`);
}
window.deployEventTimer = async function() {
    if (!window.FirebaseBridge) return;
    const days = parseInt(document.getElementById("reg-time-days").value, 10) || 0;
    const hours = parseInt(document.getElementById("reg-time-hours").value, 10) || 0;
    const minutes = parseInt(document.getElementById("reg-time-minutes").value, 10) || 0;
    const seconds = parseInt(document.getElementById("reg-time-seconds").value, 10) || 0;

    const totalMs = ((days * 86400) + (hours * 3600) + (minutes * 60) + seconds) * 1000;
    if (totalMs <= 0) {
        await customAlert("Invalid Duration", "Please enter a registration duration greater than zero.", "error");
        return;
    }
    const targetTimestamp = new Date().getTime() + totalMs;

    const isConfirmed = await customConfirm("Deploy Timer", "This will start the event and begin the countdown for the duration entered.", "info");
    if (!isConfirmed) return;

    const { db, doc, setDoc } = window.FirebaseBridge;
    try {
        await setDoc(doc(db, "configuration", "event"), { status: "open", endsAt: targetTimestamp, deployedAt: new Date().getTime() }, { merge: true });
        await customAlert("Deployed", "The event is now live and the countdown has started.", "success");
    } catch (err) { await customAlert("Error", "Failed to deploy the timer.", "error"); }
}

window.resetEventTimer = async function() {
    const isConfirmed = await customConfirm("Reset Timer", "Clear the countdown and reset the registration time?", "error");
    if (!isConfirmed) return;

    ["reg-time-days", "reg-time-hours", "reg-time-minutes", "reg-time-seconds"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = "";
    });

    if (!window.FirebaseBridge) return;
    const { db, doc, setDoc } = window.FirebaseBridge;
    try {
        await setDoc(doc(db, "configuration", "event"), { endsAt: null, deployedAt: null }, { merge: true });
        await customAlert("Reset", "The registration timer has been reset.", "success");
    } catch (err) { await customAlert("Error", "Failed to reset the timer.", "error"); }
}

window.setEventStatus = async function(status) {
    if (!window.FirebaseBridge) return;
    const confirmChoice = await customConfirm("Change Event Status", `Are you sure you want to turn the event ${status.toUpperCase()}?`);
    if(!confirmChoice) return;

    const { db, doc, setDoc } = window.FirebaseBridge;
    try {
        const payload = { status: status };
        if (status === 'closed') {
            /* Interlock: manually ending the event clears any active countdown so it
               cannot keep ticking in the background. Baseline resets to 00:00:00:00
               unless a new automated countdown is explicitly deployed afterwards. */
            if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
            payload.endsAt = null;
        }
        await setDoc(doc(db, "configuration", "event"), payload, { merge: true });
        await customAlert("Status Updated", `The event is now ${status.toUpperCase()}.`, "success");
    } catch(err) { await customAlert("Error", "Failed to update event status.", "error"); }
}

let autoEndTriggeredForEndsAt = null;

/* Silent, automated counterpart to setEventStatus('closed') — fires the exact moment
   the deployed countdown hits zero, with no confirmation prompt (manual END EVENT
   remains available as a fallback at any time). Guarded so it only fires once per
   deployed target timestamp, even if multiple render ticks land at/under zero. */
async function autoEndEventOnTimerZero(endsAt) {
    if (autoEndTriggeredForEndsAt === endsAt) return;
    autoEndTriggeredForEndsAt = endsAt;
    if (!window.FirebaseBridge) return;
    const { db, doc, setDoc } = window.FirebaseBridge;
    try {
        await setDoc(doc(db, "configuration", "event"), { status: "closed", endsAt: null }, { merge: true });
    } catch (err) { console.error(err); }
}

function startLiveCountdown(endsAt) {
    if (countdownInterval) clearInterval(countdownInterval);
    const display = document.getElementById("live-countdown-display");
    const targetDateDisplay = document.getElementById("live-target-date-display");
    if (!display) return;

    if (!endsAt) {
        display.innerText = "--:--:--:--";
        if (targetDateDisplay) targetDateDisplay.innerText = "No target date set";
        return;
    }

    if (targetDateDisplay) {
        targetDateDisplay.innerText = new Date(endsAt).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    const render = () => {
        const remainingMs = endsAt - new Date().getTime();
        if (remainingMs <= 0) {
            display.innerText = "00:00:00:00";
            clearInterval(countdownInterval);
            autoEndEventOnTimerZero(endsAt);
            return;
        }
        const totalSec = Math.floor(remainingMs / 1000);
        const d = Math.floor(totalSec / 86400);
        const h = Math.floor((totalSec % 86400) / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        const pad = n => String(n).padStart(2, "0");
        display.innerText = `${pad(d)}:${pad(h)}:${pad(m)}:${pad(s)}`;
    };
    render();
    countdownInterval = setInterval(render, 1000);
}
let selectedAnnounceType = 'info';
let selectedNoticeType = 'warning';

window.selectAnnounceType = function(type) {
    selectedAnnounceType = type;
    document.querySelectorAll('#announce-type-tabs .segment-btn').forEach(btn => {
        btn.classList.toggle('active', (btn.getAttribute('onclick') || '').includes(`'${type}'`));
    });
};

window.selectNoticeType = function(type) {
    selectedNoticeType = type;
    document.querySelectorAll('#notice-type-tabs .segment-btn').forEach(btn => {
        btn.classList.toggle('active', (btn.getAttribute('onclick') || '').includes(`'${type}'`));
    });
};

window.publishAnnouncement = async function() {
    const message = document.getElementById("announce-message").value.trim();
    const autohideRaw = document.getElementById("announce-autohide").value.trim();
    if (!message || !autohideRaw) { await customAlert("Empty", "Enter an announcement message and set the auto-hide timer first.", "error"); return; }
    if (!window.FirebaseBridge) return;

    const secs = parseInt(autohideRaw, 10);
    const autoHideMs = (!isNaN(secs) && secs > 0) ? secs * 1000 : 0; // 0 = persist until cleared

    const { db, doc, setDoc, writeBatch } = window.FirebaseBridge;
    try {
        // Mutually exclusive with the Notice Banner: publishing this turns the other off.
        const batch = writeBatch(db);
        batch.set(doc(db, "announcements", "current"), {
            message,
            type: selectedAnnounceType,
            autoHideMs,
            active: true,
            timestamp: new Date().getTime()
        }, { merge: true });
        batch.set(doc(db, "configuration", "systemStatus"), { active: false }, { merge: true });
        await batch.commit();
        await customAlert("Published", "Announcement is now live on the Main Website.", "success");
    } catch (err) { await customAlert("Error", "Failed to publish the announcement.", "error"); }
};

window.clearAnnouncement = async function() {
    const isConfirmed = await customConfirm("Clear Announcement", "Hide the current announcement from the Main Website?", "warning");
    if (!isConfirmed) return;
    if (!window.FirebaseBridge) return;
    const { db, doc, setDoc } = window.FirebaseBridge;
    try {
        await setDoc(doc(db, "announcements", "current"), { active: false }, { merge: true });
        document.getElementById("announce-autohide").value = '';
        await customAlert("Cleared", "Announcement hidden.", "success");
    } catch (err) { await customAlert("Error", "Failed to clear the announcement.", "error"); }
};

window.setNotice = async function(turnOn) {
    if (!window.FirebaseBridge) return;
    const message = document.getElementById("notice-message").value.trim();
    if (turnOn && !message) { await customAlert("Empty", "Enter a notice message first.", "error"); return; }

    const isConfirmed = await customConfirm(
        turnOn ? "Turn On Notice" : "Turn Off Notice",
        turnOn ? "Show the notice banner on the Main Website now?" : "Remove the notice banner from the Main Website?",
        turnOn ? "warning" : "info"
    );
    if (!isConfirmed) return;

    const { db, doc, setDoc, writeBatch } = window.FirebaseBridge;
    try {
        if (turnOn) {
            // Mutually exclusive with the Announcement Banner: publishing this turns the other off.
            const batch = writeBatch(db);
            batch.set(doc(db, "configuration", "systemStatus"), {
                active: true,
                type: selectedNoticeType,
                message: message
            }, { merge: true });
            batch.set(doc(db, "announcements", "current"), { active: false }, { merge: true });
            await batch.commit();
        } else {
            await setDoc(doc(db, "configuration", "systemStatus"), { active: false }, { merge: true });
        }
        await customAlert("Updated", turnOn ? "Notice banner is now live." : "Notice banner turned off.", "success");
    } catch (err) { await customAlert("Error", "Failed to update notice status.", "error"); }
};

/* Live-load current notice/banner state so the admin always sees what is
   currently published. Both banners are publish-driven only: the STATUS badge,
   preview text, and timer update strictly from Firestore (onSnapshot), never
   from raw keystrokes in the EDIT TEXT / SET TIMER fields. Because publishing
   one banner always writes active:false to the other (see publishAnnouncement
   and setNotice above), these two independent listeners naturally stay mutually
   exclusive — only one can ever show STATUS: ON at a time. */
function initializeRealtimeNoticesStreams() {
    if (!window.FirebaseBridge) return;
    const { db, doc, onSnapshot } = window.FirebaseBridge;

    onSnapshot(doc(db, "announcements", "current"), (snap) => {
        const isActive = snap.exists() && snap.data().active === true;
        const data = snap.exists() ? snap.data() : {};

        const textEl = document.getElementById("announce-preview-text");
        const timerEl = document.getElementById("announce-preview-timer");
        const statusText = document.getElementById("announce-status-text");
        const statusDot = document.getElementById("announce-status-dot");
        const badge = document.getElementById("announce-status-badge");

        if (textEl) textEl.innerText = isActive ? (data.message || '') : '';
        if (timerEl) timerEl.innerText = isActive ? (data.autoHideMs ? `${data.autoHideMs / 1000}s` : 'NONE') : '';
        if (statusText) statusText.innerText = isActive ? "ON" : "OFF";
        if (statusDot) statusDot.classList.toggle("closed", !isActive);
        if (badge) badge.classList.toggle("status-off", !isActive);
    });

    onSnapshot(doc(db, "configuration", "systemStatus"), (snap) => {
        const isActive = snap.exists() && snap.data().active === true;
        const data = snap.exists() ? snap.data() : {};

        const textEl = document.getElementById("notice-preview-text");
        const statusText = document.getElementById("notice-status-text");
        const statusDot = document.getElementById("notice-status-dot");
        const badge = document.getElementById("notice-status-badge");

        if (textEl) textEl.innerText = isActive ? (data.message || '') : '';
        if (statusText) statusText.innerText = isActive ? "ON" : "OFF";
        if (statusDot) statusDot.classList.toggle("closed", !isActive);
        if (badge) badge.classList.toggle("status-off", !isActive);
    });
}