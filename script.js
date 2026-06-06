let activeFirestoreSubmissionsSnapshot = [];
let activeFirestoreWinnerHistorySnapshot = [];
let activeArchiveSnapshot = [];

window.addEventListener("load", () => {
    setTimeout(() => {
        const loader = document.getElementById("global-page-loader");
        if (loader) loader.classList.add("hidden");
    }, 400);
});

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
        
        iconEl.innerHTML = `<svg viewBox="0 0 24 24" width="48" height="48" fill="#FFD200"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>`;

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
        
        document.getElementById("admin-auth-overlay").classList.add("hidden");
        document.getElementById("admin-panel-view").classList.remove("hidden");
        switchAdminTab("tab-prize-management");
        switchPrizeSubTab("sub-latest-prize");

        initializeRealtimeConfigurationStreams();
        initializeRealtimeSubmissionDataStreams();
        initializeRealtimeWinnerHistoryStreams();
    } catch (error) {
        await customAlert("ACCESS DENIED", "INVALID GATEWAY AUTHORIZATION SIGNATURE.", "error");
    }
}

window.switchAdminTab = function(targetTabId) {
    document.querySelectorAll(".admin-tab-content").forEach(tab => tab.classList.remove("active"));
    document.querySelectorAll(".admin-tabs-nav .tab-btn").forEach(btn => btn.classList.remove("active"));
    document.getElementById(targetTabId).classList.add("active");
    const activeBtn = Array.from(document.querySelectorAll(".admin-tabs-nav .tab-btn")).find(btn => btn.getAttribute("onclick").includes(targetTabId));
    if (activeBtn) activeBtn.classList.add("active");
}

window.switchPrizeSubTab = function(targetTabId) {
    document.querySelectorAll(".prize-sub-tab").forEach(tab => tab.classList.add("hidden"));
    document.querySelectorAll("#tab-prize-management .p-tab-btn").forEach(btn => btn.classList.remove("active"));
    document.getElementById(targetTabId).classList.remove("hidden");
    const activeBtn = Array.from(document.querySelectorAll("#tab-prize-management .p-tab-btn")).find(btn => btn.getAttribute("onclick").includes(targetTabId));
    if(activeBtn) activeBtn.classList.add("active");
}

function initializeRealtimeConfigurationStreams() {
    if (!window.FirebaseBridge) return;
    const { db, doc, onSnapshot } = window.FirebaseBridge;

    onSnapshot(doc(db, "configuration", "livePrize"), (docSnapshot) => {
        let imgUrl = "", captionStr = "Loading prize details...";
        if (docSnapshot.exists()) {
            const data = docSnapshot.data();
            if (data.imageUrl) imgUrl = data.imageUrl;
            if (data.caption) captionStr = data.caption;
        }
        if (imgUrl) {
            const adminImg = document.getElementById("admin-prize-preview-img");
            if(adminImg.src !== imgUrl) { adminImg.classList.add("img-loading"); adminImg.src = imgUrl; }
        }
        document.getElementById("admin-prize-preview-cap").innerText = captionStr;
    });

    onSnapshot(doc(db, "configuration", "pastPrize"), (docSnapshot) => {
        let imgUrl = "", captionStr = "Loading past rewards...";
        if (docSnapshot.exists()) {
            const data = docSnapshot.data();
            if (data.imageUrl) imgUrl = data.imageUrl;
            if (data.caption) captionStr = data.caption;
        }
        if (imgUrl) {
            const adminPastImg = document.getElementById("admin-past-prize-preview-img");
            if(adminPastImg.src !== imgUrl) { adminPastImg.classList.add("img-loading"); adminPastImg.src = imgUrl; }
        }
        document.getElementById("admin-past-prize-preview-cap").innerText = captionStr;
    });

    onSnapshot(doc(db, "configuration", "event"), (docSnapshot) => {
        let liveEventStatus = "open";
        if(docSnapshot.exists() && docSnapshot.data().status) { liveEventStatus = docSnapshot.data().status; }

        const statusBadge = document.getElementById("current-event-status-badge");
        if(liveEventStatus === "closed") {
            if(statusBadge) { statusBadge.innerText = "STATUS: ENDED / CLOSED"; statusBadge.style.backgroundColor = "rgba(255, 59, 48, 0.1)"; statusBadge.style.color = "#FF3B30"; statusBadge.style.border = "1px solid rgba(255, 59, 48, 0.3)"; }
        } else {
            if(statusBadge) { statusBadge.innerText = "STATUS: ACTIVE / OPEN"; statusBadge.style.backgroundColor = "rgba(52, 199, 89, 0.1)"; statusBadge.style.color = "#39FF14"; statusBadge.style.border = "1px solid rgba(52, 199, 89, 0.3)"; }
        }
    });
}

function initializeRealtimeSubmissionDataStreams() {
    if (!window.FirebaseBridge) return;
    const { db, collection, query, onSnapshot } = window.FirebaseBridge;

    onSnapshot(query(collection(db, "submissions")), (querySnapshot) => {
        activeFirestoreSubmissionsSnapshot = [];
        activeArchiveSnapshot = [];
        querySnapshot.forEach(doc => {
            const d = doc.data();
            if(d.status === "archived") activeArchiveSnapshot.push({ id: doc.id, ...d });
            else activeFirestoreSubmissionsSnapshot.push({ id: doc.id, ...d });
        });
        activeFirestoreSubmissionsSnapshot.sort((x, y) => (y.timestamp || 0) - (x.timestamp || 0));
        activeArchiveSnapshot.sort((x, y) => (y.timestamp || 0) - (x.timestamp || 0));

        buildAdminApprovalBoardTableUI();
        buildArchiveTableUI();
    });
}

function initializeRealtimeWinnerHistoryStreams() {
    if (!window.FirebaseBridge) return;
    const { db, collection, query, onSnapshot } = window.FirebaseBridge;

    onSnapshot(query(collection(db, "winnerHistory")), (querySnapshot) => {
        activeFirestoreWinnerHistorySnapshot = [];
        querySnapshot.forEach(doc => { activeFirestoreWinnerHistorySnapshot.push({ id: doc.id, ...doc.data() }); });
        activeFirestoreWinnerHistorySnapshot.sort((x, y) => (y.wonAt || 0) - (x.wonAt || 0));
        buildAdminWinnerHistoryUI();
    });
}

function buildAdminApprovalBoardTableUI() {
    const tableBody = document.getElementById("admin-approval-table-body");
    if (!tableBody) return;

    if (activeFirestoreSubmissionsSnapshot.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="6" class="text-center" style="color: #A5A6B9; padding: 40px 0;">No active submissions found.</td></tr>`;
        return;
    }

    let html = "";
    activeFirestoreSubmissionsSnapshot.forEach(item => {
        const badgeClass = item.status === "approved" ? "status-badge approved" : (item.status === "rejected" ? "status-badge rejected" : "status-badge pending");
        html += `
            <tr>
                <td>${escapeHtml(item.name)}</td>
                <td>${item.age}</td>
                <td>${escapeHtml(item.phone)}</td>
                <td>${escapeHtml(item.gameId)}</td>
                <td><span class="${badgeClass}">${item.status.toUpperCase()}</span></td>
                <td>
                    <div class="table-actions-cluster">
                        ${item.status !== 'approved' ? `<button class="circle-action-btn approve-check" title="Approve Entry" onclick="setSubmissionStatus('${item.id}', 'approved')"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></button>` : ''}
                        ${item.status !== 'rejected' ? `<button class="circle-action-btn reject-cross" title="Reject Entry" onclick="setSubmissionStatus('${item.id}', 'rejected')"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>` : ''}
                    </div>
                </td>
            </tr>`;
    });
    tableBody.innerHTML = html;
}

function buildArchiveTableUI() {
    const tableBody = document.getElementById("admin-archive-table-body");
    if(!tableBody) return;

    if(activeArchiveSnapshot.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="5" class="text-center" style="color: #A5A6B9; padding: 40px 0;">No winners pending review in archive.</td></tr>`;
        return;
    }

    let html = "";
    activeArchiveSnapshot.forEach(item => {
        const dateStr = new Date(item.timestamp || Date.now()).toLocaleDateString();
        html += `
            <tr>
                <td>${escapeHtml(item.name)}</td>
                <td>${escapeHtml(item.gameId)}</td>
                <td>${escapeHtml(item.phone)}</td>
                <td>${dateStr}</td>
                <td>
                    <div class="table-actions-cluster">
                        <button class="circle-action-btn approve-check" title="Approve to Dashboard / Spin Again" onclick="setSubmissionStatus('${item.id}', 'approved')"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></button>
                        <button class="circle-action-btn reject-cross" title="Permanently Delete" onclick="removeSingleSubmission('${item.id}')"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>
                    </div>
                </td>
            </tr>`;
    });
    tableBody.innerHTML = html;
}

function buildAdminWinnerHistoryUI() {
    const tableBody = document.getElementById("admin-history-table-body");
    if (!tableBody) return;

    if (activeFirestoreWinnerHistorySnapshot.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="5" class="text-center" style="color: #A5A6B9; padding: 40px 0;">No winner history logged.</td></tr>`;
        return;
    }

    let html = "";
    activeFirestoreWinnerHistorySnapshot.forEach(item => {
        const dateStr = new Date(item.wonAt || Date.now()).toLocaleString();
        html += `
            <tr>
                <td>${dateStr}</td>
                <td>${escapeHtml(item.name)}</td>
                <td>
                    <div class="copy-cell-flex">
                        ${escapeHtml(item.gameId)}
                        <button class="btn-copy-svg" onclick="copyToClipboardText('${escapeHtml(item.gameId)}')"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg></button>
                    </div>
                </td>
                <td>
                    <div class="copy-cell-flex">
                        ${escapeHtml(item.phone)}
                        <button class="btn-copy-svg" onclick="copyToClipboardText('${escapeHtml(item.phone)}')"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg></button>
                    </div>
                </td>
                <td>
                    <div class="table-actions-cluster">
                        <button class="circle-action-btn history-del" title="Remove History Log" onclick="removeWinnerHistoryRecord('${item.id}')"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>
                    </div>
                </td>
            </tr>`;
    });
    tableBody.innerHTML = html;
}

window.handleCloudinaryUpload = async function(inputElem, type) {
    if (!inputElem.files || !inputElem.files[0]) return;
    const file = inputElem.files[0];
    
    const progressContainer = document.getElementById(`upload-progress-${type}`);
    const percentSpan = document.getElementById(`progress-percent-${type}`);
    const speedSpan = document.getElementById(`progress-speed-${type}`);
    const fillBar = document.getElementById(`progress-bar-fill-${type}`);
    
    progressContainer.classList.remove("hidden");
    
    const formData = new FormData();
    formData.append('file', file);
    formData.append('upload_preset', 'tzerone_giveaway');

    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://api.cloudinary.com/v1_1/dqxkdcnx4/image/upload');

    let startTime = new Date().getTime();

    xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
            const percent = Math.round((e.loaded / e.total) * 100);
            fillBar.style.width = percent + '%';
            percentSpan.innerText = percent + '%';
            const timeElapsed = (new Date().getTime() - startTime) / 1000;
            const bytesPerSec = e.loaded / timeElapsed;
            const kbPerSec = (bytesPerSec / 1024).toFixed(1);
            speedSpan.innerText = kbPerSec + ' KB/s';
        }
    };

    xhr.onload = async () => {
        if (xhr.status === 200) {
            const res = JSON.parse(xhr.responseText);
            const secureUrl = res.secure_url;
            
            if(type === 'latest') {
                const imgElement = document.getElementById("admin-prize-preview-img");
                imgElement.classList.add('img-loading');
                imgElement.src = secureUrl;
                imgElement.setAttribute("data-new-url", secureUrl);
            } else {
                const imgElement = document.getElementById("admin-past-prize-preview-img");
                imgElement.classList.add('img-loading');
                imgElement.src = secureUrl;
                imgElement.setAttribute("data-new-url", secureUrl);
            }
            await customAlert("Upload Complete", "Image processed successfully. Click Save Changes to overwrite the live database.", "success");
        } else {
            await customAlert("Upload Failed", "Cloudinary storage error.", "error");
        }
        setTimeout(() => progressContainer.classList.add("hidden"), 2000);
    };

    xhr.onerror = async () => {
        await customAlert("Upload Failed", "Network exception occurred.", "error");
        progressContainer.classList.add("hidden");
    };

    xhr.send(formData);
};

window.saveActivePrizeData = async function() {
    if (!window.FirebaseBridge) return;
    const { db, doc, setDoc } = window.FirebaseBridge;
    const inputCaption = document.getElementById("admin-input-caption").value.trim();
    const previewImg = document.getElementById("admin-prize-preview-img");
    
    let finalImageUrl = previewImg.getAttribute("data-new-url") || previewImg.src;
    let finalCaption = inputCaption || document.getElementById("admin-prize-preview-cap").innerText;

    try {
        await setDoc(doc(db, "configuration", "livePrize"), {
            imageUrl: finalImageUrl,
            caption: finalCaption,
            lastModified: new Date().getTime()
        }, { merge: true });

        document.getElementById("admin-input-caption").value = "";
        previewImg.removeAttribute("data-new-url");
        await customAlert("Success", "Prize updated. The database has overwritten the old image with the newly uploaded one.", "success");
    } catch (err) { await customAlert("Error", "Failed to sync structural values.", "error"); }
}

window.saveActivePastPrizeData = async function() {
    if (!window.FirebaseBridge) return;
    const { db, doc, setDoc } = window.FirebaseBridge;
    const inputCaption = document.getElementById("admin-input-past-caption").value.trim();
    const previewImg = document.getElementById("admin-past-prize-preview-img");
    
    let finalImageUrl = previewImg.getAttribute("data-new-url") || previewImg.src;
    let finalCaption = inputCaption || document.getElementById("admin-past-prize-preview-cap").innerText;

    try {
        await setDoc(doc(db, "configuration", "pastPrize"), {
            imageUrl: finalImageUrl,
            caption: finalCaption,
            lastModified: new Date().getTime()
        }, { merge: true });

        document.getElementById("admin-input-past-caption").value = "";
        previewImg.removeAttribute("data-new-url");
        await customAlert("Success", "Past Prize updated. Old image permanently overridden in database.", "success");
    } catch (err) { await customAlert("Error", "Failed to sync structural values.", "error"); }
}

window.setEventStatus = async function(status) {
    if (!window.FirebaseBridge) return;
    const confirmChoice = await customConfirm("Change Event Status", `Are you sure you want to turn the event ${status.toUpperCase()}?`);
    if(!confirmChoice) return;

    const { db, doc, setDoc } = window.FirebaseBridge;
    try {
        await setDoc(doc(db, "configuration", "event"), { status: status });
        await customAlert("Status Updated", `The event is now ${status.toUpperCase()}.`, "success");
    } catch(err) { await customAlert("Error", "Failed to update event status.", "error"); }
}

window.setSubmissionStatus = async function(documentId, targetStatus) {
    if (!window.FirebaseBridge) return;
    const { db, doc, updateDoc } = window.FirebaseBridge;
    try { await updateDoc(doc(db, "submissions", documentId), { status: targetStatus }); } catch (err) { console.error(err); }
}

window.acceptAllApprovals = async function() {
    const isConfirmed = await customConfirm("Approve All", "Are you sure you want to approve ALL pending submissions?", "info");
    if (!isConfirmed) return;
    if (!window.FirebaseBridge) return;
    
    const { db, doc, updateDoc } = window.FirebaseBridge;
    const pendingRecords = activeFirestoreSubmissionsSnapshot.filter(item => item.status === "pending");
    if (pendingRecords.length === 0) {
        await customAlert("Empty", "No pending submissions to approve.", "info");
        return;
    }
    try {
        const promises = pendingRecords.map(item => updateDoc(doc(db, "submissions", item.id), { status: "approved" }));
        await Promise.all(promises);
        await customAlert("Success", "All pending records have been successfully approved.", "success");
    } catch (err) { await customAlert("Error", "Error while processing batch approval.", "error"); }
}

window.removeSingleSubmission = async function(documentId) {
    const isConfirmed = await customConfirm("Permanent Deletion", "Permanently erase this record from database registries?", "error");
    if (!isConfirmed) return;
    if (!window.FirebaseBridge) return;
    const { db, doc, deleteDoc } = window.FirebaseBridge;
    try { await deleteDoc(doc(db, "submissions", documentId)); } catch (err) {}
}

window.removeWinnerHistoryRecord = async function(documentId) {
    const isConfirmed = await customConfirm("Delete History", "Permanently remove this past winner from the history logs?", "error");
    if (!isConfirmed) return;
    if (!window.FirebaseBridge) return;
    const { db, doc, deleteDoc } = window.FirebaseBridge;
    try { await deleteDoc(doc(db, "winnerHistory", documentId)); } catch (err) {}
}

window.wipeAllSubmissionsSeason = async function() {
    const isConfirmed = await customConfirm("CRITICAL WARNING", "This completely wipes ALL entries from the system for the season. Proceed?", "error");
    if (!isConfirmed) return;
    if (!window.FirebaseBridge) return;
    
    const { db, doc, deleteDoc } = window.FirebaseBridge;
    try {
        const promises = activeFirestoreSubmissionsSnapshot.map(item => deleteDoc(doc(db, "submissions", item.id)));
        await Promise.all(promises);
        await customAlert("System Reset", "Database structure reset completed safely.", "success");
    } catch (err) { await customAlert("Failure", "Batch execution failure.", "error"); }
}

window.openHistoryPopup = function() {
    document.getElementById("history-modal-overlay").classList.remove("hidden");
    renderLogList('approved');
    renderLogList('rejected');
    renderLogList('winners');
}

window.closeHistoryPopup = function() { document.getElementById("history-modal-overlay").classList.add("hidden"); }

window.switchHistoryLogTab = function(targetId) {
    document.querySelectorAll(".history-log-content").forEach(c => c.classList.add("hidden"));
    document.querySelectorAll("#history-modal-overlay .p-tab-btn").forEach(b => b.classList.remove("active"));
    document.getElementById(targetId).classList.remove("hidden");
    const activeBtn = Array.from(document.querySelectorAll("#history-modal-overlay .p-tab-btn")).find(btn => btn.getAttribute("onclick").includes(targetId));
    if(activeBtn) activeBtn.classList.add("active");
}

function renderLogList(type) {
    let html = "";
    if(type === 'winners') {
        if(activeFirestoreWinnerHistorySnapshot.length === 0) html = `<div class="empty-state-text">No winners found.</div>`;
        activeFirestoreWinnerHistorySnapshot.forEach(item => {
            html += `<div class="player-row-item"><span>${escapeHtml(item.name)}</span><span class="p-meta-id">${escapeHtml(item.gameId)} | ${escapeHtml(item.phone)}</span></div>`;
        });
        document.getElementById("list-log-winners").innerHTML = html;
        return;
    }

    const filtered = activeFirestoreSubmissionsSnapshot.filter(x => x.status === type);
    if(filtered.length === 0) html = `<div class="empty-state-text">No ${type} records found.</div>`;
    filtered.forEach(item => {
        html += `<div class="player-row-item"><span>${escapeHtml(item.name)}</span><span class="p-meta-id">${escapeHtml(item.gameId)} | ${escapeHtml(item.phone)}</span></div>`;
    });
    document.getElementById(`list-log-${type}`).innerHTML = html;
}

window.exportSpecificLog = function(statusType) {
    const data = activeFirestoreSubmissionsSnapshot.filter(x => x.status === statusType);
    if(data.length === 0) return customAlert("Empty", "No data to export.", "info");
    downloadTxtFile(data, `TZERONE_${statusType.toUpperCase()}_LOG`);
}

window.clearSpecificLog = async function(statusType) {
    const confirmChoice = await customConfirm("Delete Log", `Permanently delete all ${statusType} logs?`, "error");
    if(!confirmChoice) return;
    if(!window.FirebaseBridge) return;
    const { db, doc, deleteDoc } = window.FirebaseBridge;
    const data = activeFirestoreSubmissionsSnapshot.filter(x => x.status === statusType);
    data.forEach(item => deleteDoc(doc(db, "submissions", item.id)));
    openHistoryPopup();
}

window.exportWinnerLog = function() {
    if(activeFirestoreWinnerHistorySnapshot.length === 0) return customAlert("Empty", "No data to export.", "info");
    downloadTxtFile(activeFirestoreWinnerHistorySnapshot, "TZERONE_WINNERS_LOG");
}

window.clearWinnerLog = async function() {
    const confirmChoice = await customConfirm("Delete Winners", `Permanently delete all winner logs?`, "error");
    if(!confirmChoice) return;
    if(!window.FirebaseBridge) return;
    const { db, doc, deleteDoc } = window.FirebaseBridge;
    activeFirestoreWinnerHistorySnapshot.forEach(item => deleteDoc(doc(db, "winnerHistory", item.id)));
    openHistoryPopup();
}

function downloadTxtFile(arrayData, filenamePrefix) {
    let str = "==================================================\n";
    str += `        ${filenamePrefix} EXPORT        \n`;
    str += ` DATE: ${new Date().toISOString()} \n`;
    str += "==================================================\n\n";

    arrayData.forEach((item, idx) => {
        str += `${idx + 1}. NAME: ${item.name} | ID: ${item.gameId} | PHONE: ${item.phone}\n`;
    });

    const blob = new Blob([str], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement("a");
    a.download = `${filenamePrefix}_${new Date().getTime()}.txt`;
    a.href = window.URL.createObjectURL(blob);
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

window.copyToClipboardText = function(text) {
    if (!text) return;
    if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(text).catch(() => fallbackCopyTextToClipboard(text)); } 
    else { fallbackCopyTextToClipboard(text); }
}

function fallbackCopyTextToClipboard(text) {
    let textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.opacity = "0";
    document.body.appendChild(textArea);
    textArea.select();
    try { document.execCommand('copy'); } catch (err) {}
    textArea.remove();
}

function escapeHtml(str) {
    if (!str) return "";
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
