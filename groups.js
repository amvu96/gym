/* ============================================================
   GROUP CHALLENGES
   Shared, multi-writer group data — separate from the single-user
   localStorage/Firestore blob the rest of the app uses. Requires sign-in
   (there's no meaningful "offline group"), reuses the same Firebase app
   instance firebase-sync.js already created (via window.GymSync.getDb()/
   getAuth()), and reuses app.js's toast/confirm/sheet primitives (via
   window.GymUI) so it looks and behaves like the rest of the app.

   Data model (Firestore):
   groups/{groupId}
     name, ownerUid, ownerName, inviteCode, createdAt, memberUids:[uid,...]
   groups/{groupId}/members/{uid}
     uid, displayName, photoURL, color, colorIndex, joinedAt
   groups/{groupId}/challenges/{challengeId}
     title, targetLabel, startDate, endDate, createdBy, createdAt, active
   groups/{groupId}/challenges/{challengeId}/completions/{date_uid}
     uid, date, displayName, color, completedAt
   ============================================================ */
import {
  collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  query, where, orderBy, onSnapshot, runTransaction, serverTimestamp, limit
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

(function(){
  'use strict';

  const MAX_MEMBERS = 8;
  // Distinct, colorblind-considerate palette, chosen for contrast against
  // the app's dark panel background.
  const PALETTE = [
    '#39ff9a', '#3ad6ff', '#ff5f6d', '#ffb84d',
    '#c792ff', '#ff7ad9', '#ffe45e', '#7cf7c9'
  ];

  let db = null, auth = null;
  let currentUser = null;
  let myGroups = []; // [{id, ...data}]
  let myGroupsUnsub = null;

  // Detail-view state for whichever group is currently open
  let activeGroupId = null;
  let activeGroup = null;
  let activeMembers = []; // [{uid, displayName, color, ...}]
  let activeChallenge = null;
  let membersUnsub = null;
  let challengeUnsub = null;
  let completionsUnsub = null;
  let completionsByDate = {}; // { 'YYYY-MM-DD': [{uid,displayName,color}, ...] }
  let calCursor = new Date();
  let seenCompletionKeys = new Set(); // to only notify on genuinely new check-ins
  let notifiedThisSession = false; // guards the initial snapshot burst

  /* ---------------- small local date helpers (kept independent of app.js) ---------------- */
  function fmtISO(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
  function todayISO(){ return fmtISO(new Date()); }
  function parseISO(iso){ const [y,m,d]=iso.split('-').map(Number); return new Date(y,m-1,d); }

  function ui(){ return window.GymUI || {}; }
  function toast(msg){ if(ui().toast) ui().toast(msg); else console.log(msg); }

  /* ---------------- init / auth wiring ---------------- */
  function init(){
    if(!window.GymSync || !window.GymSync.isConfigured()){
      // Cloud sync not configured — groups view will show a static message.
      return;
    }
    db = window.GymSync.getDb();
    auth = window.GymSync.getAuth();
    window.GymSync.onAuthChange((user)=>{
      currentUser = user;
      teardownMyGroupsListener();
      if(user){
        listenToMyGroups();
      } else {
        myGroups = [];
        teardownAllHomeChallengeListeners();
        notifyHomeRefresh();
        if(document.getElementById('view-groups').classList.contains('active')) renderRoot();
      }
      // If the invite-landing panel is open (e.g. they just tapped
      // "Sign in with Google" from it), refresh it so the Accept button
      // appears now that we know who they are — signing in and accepting
      // are two distinct, explicit steps, not one auto-join.
      if(pendingInviteGroup) renderInvitePanel();
    });

    // Deep-link join: #join=CODE
    if(location.hash.startsWith('#join=')){
      const code = decodeURIComponent(location.hash.slice(6));
      history.replaceState(null, '', location.pathname + location.search);
      pendingJoinCode = code;
    }

    bindStaticUI();

    // A join link can land while the app boots straight to Home — jump to
    // the Groups tab ourselves instead of leaving the code stranded until
    // the person happens to tap the tab manually.
    if(pendingJoinCode && ui().showView){
      ui().showView('groups');
    }
  }

  let pendingJoinCode = null;
  let pendingInviteGroup = null; // {id, name, ownerUid, memberUids, inviteCode} once looked up

  function onShow(){
    // Called by app.js's showView('groups')
    if(pendingJoinCode){
      const code = pendingJoinCode; pendingJoinCode = null;
      handleJoinDeepLink(code);
      return;
    }
    if(pendingInviteGroup){
      renderInvitePanel();
      return;
    }
    if(activeGroupId){
      renderDetail();
    } else {
      renderRoot();
    }
  }

  // Re-render the currently open group's detail panel (used when returning
  // to the Groups tab without a pending join code, e.g. Home → Groups →
  // back). Listeners already keep the data fresh; this just re-shows the
  // right panel and repaints from state already in memory.
  function renderDetail(){
    document.getElementById('groupsPanelList').style.display = 'none';
    document.getElementById('groupsPanelInvite').style.display = 'none';
    document.getElementById('groupsPanelDetail').style.display = '';
    document.getElementById('groupDetailName').textContent = activeGroup ? activeGroup.name : '—';
    renderMembersRow();
    renderChallengeCard();
    renderGroupCalendar();
  }

  // Looks the group up by its invite code (allowed unauthenticated — see
  // firestore.rules) and shows the invite-landing panel rather than joining
  // immediately, so the person always sees what they're accepting first.
  async function handleJoinDeepLink(code){
    if(!db){ toast('Cloud sync isn\'t configured — groups need it.'); renderRoot(); return; }
    try{
      const q = query(collection(db, 'groups'), where('inviteCode', '==', code.toUpperCase()), limit(1));
      const snap = await getDocs(q);
      if(snap.empty){ toast('That invite link is invalid or expired'); renderRoot(); return; }
      const gDoc = snap.docs[0];
      pendingInviteGroup = {id: gDoc.id, ...gDoc.data()};
      renderInvitePanel();
    }catch(e){
      console.error(e);
      toast('Could not load that invite');
      renderRoot();
    }
  }

  function renderInvitePanel(){
    document.getElementById('groupsPanelList').style.display = 'none';
    document.getElementById('groupsPanelDetail').style.display = 'none';
    document.getElementById('groupsPanelInvite').style.display = '';
    document.getElementById('inviteGroupName').textContent = pendingInviteGroup.name;

    const signInBtn = document.getElementById('btnInviteSignIn');
    const acceptBtn = document.getElementById('btnInviteAccept');
    const statusEl = document.getElementById('inviteStatusText');
    signInBtn.style.display = 'none';
    acceptBtn.style.display = 'none';
    statusEl.style.display = 'none';
    statusEl.textContent = '';

    const memberUids = pendingInviteGroup.memberUids || [];
    const alreadyMember = !!(currentUser && memberUids.includes(currentUser.uid));
    const isFull = memberUids.length >= MAX_MEMBERS;

    if(!currentUser){
      signInBtn.style.display = '';
    } else if(alreadyMember){
      statusEl.textContent = "You're already in that group.";
      statusEl.style.display = '';
      acceptBtn.textContent = 'Open group';
      acceptBtn.style.display = '';
    } else if(isFull){
      statusEl.textContent = 'This group is full (8/8 members).';
      statusEl.style.display = '';
    } else {
      acceptBtn.textContent = 'Accept';
      acceptBtn.style.display = '';
    }
  }

  function clearPendingInvite(){
    pendingInviteGroup = null;
    document.getElementById('groupsPanelInvite').style.display = 'none';
  }

  async function onInviteSignIn(){
    if(!db){ toast('Cloud sync isn\'t configured — groups need it.'); return; }
    try{
      await window.GymSync.signIn();
    }catch(e){ /* handled inside signIn() itself */ }
    // onAuthStateChanged can land a beat after the popup promise resolves —
    // poll briefly rather than assuming it's already landed.
    for(let i=0; i<20 && !currentUser; i++){
      await new Promise(r=>setTimeout(r, 100));
      currentUser = window.GymSync.getCurrentUser();
    }
    if(pendingInviteGroup) renderInvitePanel();
  }

  async function onInviteAccept(){
    if(!pendingInviteGroup || !currentUser) return;
    const memberUids = pendingInviteGroup.memberUids || [];
    if(memberUids.includes(currentUser.uid)){
      const id = pendingInviteGroup.id;
      clearPendingInvite();
      openGroup(id);
      return;
    }
    const ok = await joinGroupById(pendingInviteGroup.id);
    if(ok){
      const id = pendingInviteGroup.id;
      clearPendingInvite();
      toast('Joined group');
      openGroup(id);
    }
  }

  function requireSignedIn(msg){
    if(!db){ toast('Cloud sync isn\'t configured — groups need it.'); return false; }
    if(!currentUser){
      toast(msg || 'Sign in to continue');
      if(window.GymSync) window.GymSync.signIn();
      return false;
    }
    return true;
  }

  /* ---------------- my groups list ---------------- */
  function teardownMyGroupsListener(){
    if(myGroupsUnsub){ myGroupsUnsub(); myGroupsUnsub = null; }
  }

  function listenToMyGroups(){
    const q = query(collection(db, 'groups'), where('memberUids', 'array-contains', currentUser.uid));
    myGroupsUnsub = onSnapshot(q, (snap)=>{
      myGroups = snap.docs.map(d=>({id:d.id, ...d.data()}));
      if(document.getElementById('view-groups').classList.contains('active') && !activeGroupId){
        renderRoot();
      }
      syncHomeChallengeListeners();
    }, (err)=>{ console.error('groups listen failed', err); });
  }

  /* ---------------- home-screen "today" challenge cards ----------------
     Tracked independently of whichever group is open in the Groups tab —
     the home carousel needs every group's active-and-in-range challenge
     plus this user's own "done today" status, live, regardless of which
     screen they're on. Each group gets a cheap challenge listener plus,
     only while it has a live in-range challenge, a single-document listener
     on today's own completion doc (not the whole completions collection). */
  let homeChallengeState = {}; // groupId -> {groupName, challenge, doneToday, challengeUnsub, completionUnsub}

  function syncHomeChallengeListeners(){
    const currentIds = new Set(myGroups.map(g=>g.id));
    Object.keys(homeChallengeState).forEach(gid=>{
      if(!currentIds.has(gid)){
        teardownHomeChallengeEntry(gid);
        delete homeChallengeState[gid];
      }
    });
    myGroups.forEach(g=>{
      if(!homeChallengeState[g.id]){
        homeChallengeState[g.id] = {groupName:g.name, challenge:null, doneToday:false, challengeUnsub:null, completionUnsub:null};
        attachHomeChallengeListener(g.id);
      } else {
        homeChallengeState[g.id].groupName = g.name;
      }
    });
    notifyHomeRefresh();
  }

  function teardownHomeChallengeEntry(groupId){
    const entry = homeChallengeState[groupId];
    if(!entry) return;
    if(entry.challengeUnsub) entry.challengeUnsub();
    if(entry.completionUnsub) entry.completionUnsub();
  }

  function attachHomeChallengeListener(groupId){
    const q = query(collection(db, 'groups', groupId, 'challenges'), where('active','==',true), limit(1));
    const unsub = onSnapshot(q, (snap)=>{
      const entry = homeChallengeState[groupId];
      if(!entry) return; // group was left/torn down mid-flight
      if(entry.completionUnsub){ entry.completionUnsub(); entry.completionUnsub = null; }

      if(snap.empty){
        entry.challenge = null;
        notifyHomeRefresh();
        return;
      }
      const ch = {id:snap.docs[0].id, ...snap.docs[0].data()};
      const today = todayISO();
      if(today < ch.startDate || today > ch.endDate){
        entry.challenge = null;
        notifyHomeRefresh();
        return;
      }
      entry.challenge = ch;
      entry.doneToday = false;
      notifyHomeRefresh();

      const compRef = doc(db, 'groups', groupId, 'challenges', ch.id, 'completions', `${today}_${currentUser.uid}`);
      entry.completionUnsub = onSnapshot(compRef, (compSnap)=>{
        entry.doneToday = compSnap.exists();
        notifyHomeRefresh();
      }, (err)=>console.error('home completion listen failed', err));
    }, (err)=>console.error('home challenge listen failed', err));
    homeChallengeState[groupId].challengeUnsub = unsub;
  }

  function teardownAllHomeChallengeListeners(){
    Object.keys(homeChallengeState).forEach(teardownHomeChallengeEntry);
    homeChallengeState = {};
  }

  function notifyHomeRefresh(){
    if(window.GymUI && window.GymUI.refreshHomeChallengesIfVisible) window.GymUI.refreshHomeChallengesIfVisible();
  }

  // Called by app.js's home-screen carousel to get this user's active,
  // in-range group challenges. Pure data — app.js owns the actual markup so
  // group cards render identically to routine cards, just re-themed.
  function getHomeChallengeCards(){
    return Object.entries(homeChallengeState)
      .filter(([,e])=>e.challenge)
      .map(([groupId,e])=>({
        groupId,
        groupName: e.groupName,
        title: e.challenge.title,
        targetLabel: e.challenge.targetLabel,
        doneToday: !!e.doneToday
      }));
  }

  // Called when a home-screen group-challenge card is tapped — switches to
  // the Groups tab and opens that specific group.
  function openGroupFromHome(groupId){
    if(window.GymUI && window.GymUI.showView) window.GymUI.showView('groups');
    openGroup(groupId);
  }

  function renderRoot(){
    document.getElementById('groupsPanelDetail').style.display = 'none';
    document.getElementById('groupsPanelInvite').style.display = 'none';
    document.getElementById('groupsPanelList').style.display = '';

    const container = document.getElementById('groupsListContainer');
    if(!db){
      container.innerHTML = `<div class="empty-state">
        <p>Group challenges need cloud sync configured for this app.</p>
      </div>`;
      return;
    }
    if(!currentUser){
      container.innerHTML = `<div class="empty-state">
        <p>Sign in to create or join a group challenge with friends.</p>
      </div>`;
      return;
    }
    if(myGroups.length===0){
      container.innerHTML = `<div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="9" cy="7" r="4"/><path d="M2 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2"/><circle cx="17" cy="7" r="3"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/></svg>
        <p>No groups yet. Create one or join with an invite link.</p>
      </div>`;
      return;
    }
    container.innerHTML = myGroups.map(g=>{
      const count = (g.memberUids||[]).length;
      return `<div class="card group-list-item" data-group="${g.id}" style="cursor:pointer; margin-bottom:10px;">
        <div class="row">
          <div style="min-width:0;">
            <div class="settings-row-label">${escapeHtml(g.name)}</div>
            <div class="settings-row-sub">${count}/${MAX_MEMBERS} members</div>
          </div>
        </div>
      </div>`;
    }).join('');
    container.querySelectorAll('[data-group]').forEach(el=>{
      el.addEventListener('click', ()=>openGroup(el.dataset.group));
    });
  }

  function bindStaticUI(){
    document.getElementById('btnNewGroup').addEventListener('click', ()=>{
      if(!requireSignedIn()) return;
      document.getElementById('newGroupNameInput').value = '';
      ui().openSheet('sheetCreateGroup');
    });
    document.getElementById('btnConfirmCreateGroup').addEventListener('click', createGroup);

    document.getElementById('btnJoinGroup').addEventListener('click', ()=>{
      if(!requireSignedIn()) return;
      document.getElementById('joinGroupCodeInput').value = '';
      ui().openSheet('sheetJoinGroup');
    });
    document.getElementById('btnConfirmJoinGroup').addEventListener('click', ()=>{
      const code = document.getElementById('joinGroupCodeInput').value.trim();
      if(!code){ toast('Enter an invite code'); return; }
      joinByCode(code);
    });

    document.getElementById('btnBackToGroups').addEventListener('click', closeGroup);
    document.getElementById('btnInviteMembers').addEventListener('click', showInviteSheet);
    document.getElementById('btnNtfySettings').addEventListener('click', showNtfySettingsSheet);
    document.getElementById('btnLeaveGroup').addEventListener('click', leaveActiveGroup);

    document.getElementById('btnInviteSignIn').addEventListener('click', onInviteSignIn);
    document.getElementById('btnInviteAccept').addEventListener('click', onInviteAccept);
    document.getElementById('btnInviteCancel').addEventListener('click', ()=>{
      clearPendingInvite();
      renderRoot();
    });

    document.getElementById('btnNewChallenge').addEventListener('click', ()=>{
      document.getElementById('challengeTitleInput').value = '';
      document.getElementById('challengeTargetInput').value = '';
      const t = new Date();
      document.getElementById('challengeStartInput').value = fmtISO(t);
      const end = new Date(t); end.setDate(end.getDate()+29);
      document.getElementById('challengeEndInput').value = fmtISO(end);
      ui().openSheet('sheetNewChallenge');
    });
    document.getElementById('btnConfirmNewChallenge').addEventListener('click', createChallenge);

    document.getElementById('btnMarkDoneToday').addEventListener('click', markTodayDone);

    document.getElementById('calGroupPrevMonth').addEventListener('click', ()=>{
      calCursor.setMonth(calCursor.getMonth()-1); renderGroupCalendar();
    });
    document.getElementById('calGroupNextMonth').addEventListener('click', ()=>{
      calCursor.setMonth(calCursor.getMonth()+1); renderGroupCalendar();
    });
  }

  /* ---------------- create / join ---------------- */
  function randomCode(len=6){
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
    let out = '';
    for(let i=0;i<len;i++) out += chars[Math.floor(Math.random()*chars.length)];
    return out;
  }

  // Deterministic-prefix, random-suffix ntfy topic, generated once per group
  // at creation and never editable afterward — e.g.
  // "gymnullvaulteu-morning-crew-a1b2c3". The prefix identifies it as
  // belonging to this app (so it doesn't collide with unrelated public
  // topics on ntfy.sh), the slug keeps it human-recognizable, and the
  // random suffix keeps it unguessable enough to act as ntfy's de facto
  // access gate (ntfy topics have no real auth by default).
  function slugify(s){
    return String(s||'')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'group';
  }
  function randomNtfyTopic(groupName){
    const suffix = Array.from({length:8}, ()=>'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random()*36)]).join('');
    return `gymnullvaulteu-${slugify(groupName)}-${suffix}`;
  }

  async function createGroup(){
    const name = document.getElementById('newGroupNameInput').value.trim();
    if(!name){ toast('Give the group a name'); return; }
    if(!requireSignedIn()) return;
    try{
      const inviteCode = randomCode();
      const groupRef = await addDoc(collection(db, 'groups'), {
        name,
        ownerUid: currentUser.uid,
        ownerName: currentUser.name || 'Owner',
        inviteCode,
        ntfyTopic: randomNtfyTopic(name),
        createdAt: Date.now(),
        memberUids: [currentUser.uid]
      });
      await setDoc(doc(db, 'groups', groupRef.id, 'members', currentUser.uid), {
        uid: currentUser.uid,
        displayName: currentUser.name || 'Member',
        photoURL: currentUser.photo || '',
        color: PALETTE[0],
        colorIndex: 0,
        joinedAt: Date.now()
      });
      ui().closeSheet('sheetCreateGroup');
      toast('Group created');
      openGroup(groupRef.id);
    }catch(e){
      console.error(e);
      toast('Could not create group: ' + (e.message||e.code||''));
    }
  }

  async function joinByCode(code){
    if(!requireSignedIn()) return;
    try{
      const q = query(collection(db, 'groups'), where('inviteCode', '==', code.toUpperCase()), limit(1));
      const snap = await getDocs(q);
      if(snap.empty){ toast('No group found with that code'); return; }
      const groupId = snap.docs[0].id;

      const memberRef = doc(db, 'groups', groupId, 'members', currentUser.uid);
      const existing = await getDoc(memberRef);
      if(existing.exists()){
        ui().closeSheet('sheetJoinGroup');
        openGroup(groupId);
        return;
      }

      const ok = await joinGroupById(groupId);
      if(ok){
        ui().closeSheet('sheetJoinGroup');
        toast('Joined group');
        openGroup(groupId);
      }
    }catch(e){
      console.error(e);
      toast(e.message || 'Could not join group');
    }
  }

  // Shared join transaction, used both by the code-entry sheet and the
  // invite-landing page's Accept button. Atomically checks capacity and
  // claims the next free color, so two people accepting at the same moment
  // can't both grab the same color or push the group past MAX_MEMBERS.
  // Returns true on success, false (after toasting) on failure.
  async function joinGroupById(groupId){
    let joined = false, groupName = null, groupTopic = null;
    try{
      await runTransaction(db, async (tx)=>{
        const gRef = doc(db, 'groups', groupId);
        const gSnap = await tx.get(gRef);
        if(!gSnap.exists()) throw new Error('Group no longer exists');
        const data = gSnap.data();
        groupName = data.name;
        groupTopic = data.ntfyTopic;
        const memberUids = data.memberUids || [];
        if(memberUids.includes(currentUser.uid)) return; // already a member
        if(memberUids.length >= MAX_MEMBERS) throw new Error('This group is full (8/8 members)');

        // We can't read the whole members subcollection inside a transaction
        // against an arbitrary-length list cheaply, so colorIndex is derived
        // from position in memberUids, which we already have transactionally.
        const colorIndex = memberUids.length % PALETTE.length;

        tx.update(gRef, { memberUids: [...memberUids, currentUser.uid] });
        tx.set(doc(db, 'groups', groupId, 'members', currentUser.uid), {
          uid: currentUser.uid,
          displayName: currentUser.name || 'Member',
          photoURL: currentUser.photo || '',
          color: PALETTE[colorIndex],
          colorIndex,
          joinedAt: Date.now()
        });
        joined = true;
      });
      if(joined && groupTopic){
        publishNtfy(groupTopic, {
          title: groupName,
          message: `${firstName(currentUser.name)} joined the group`,
          tags: ['wave']
        });
      }
      return true;
    }catch(e){
      console.error(e);
      toast(e.message || 'Could not join group');
      return false;
    }
  }

  async function leaveActiveGroup(){
    if(!activeGroupId) return;
    const ok = ui().confirmDialog ? await ui().confirmDialog({
      title:'Leave group?', message:'You\'ll stop seeing this group\'s challenge and calendar.', confirmLabel:'Leave', danger:true
    }) : confirm('Leave this group?');
    if(!ok) return;
    try{
      const gRef = doc(db, 'groups', activeGroupId);
      const gSnap = await getDoc(gRef);
      if(gSnap.exists()){
        const memberUids = (gSnap.data().memberUids||[]).filter(u=>u!==currentUser.uid);
        await updateDoc(gRef, { memberUids });
      }
      await deleteDoc(doc(db, 'groups', activeGroupId, 'members', currentUser.uid));
      if(activeGroup && activeGroup.ntfyTopic){
        publishNtfy(activeGroup.ntfyTopic, {
          title: activeGroup.name,
          message: `${firstName(currentUser.name)} left the group`,
          tags: ['wave']
        });
      }
      toast('Left group');
      closeGroup();
    }catch(e){
      console.error(e);
      toast('Could not leave group');
    }
  }

  /* ---------------- invite sheet (link + QR) ---------------- */
  function showInviteSheet(){
    if(!activeGroup) return;
    const link = `${location.origin}${location.pathname}#join=${activeGroup.inviteCode}`;
    document.getElementById('inviteLinkText').textContent = link;
    document.getElementById('inviteCodeText').textContent = activeGroup.inviteCode;
    ui().openSheet('sheetInvite');
    renderQr(link);

    document.getElementById('btnCopyInviteLink').onclick = async ()=>{
      try{ await navigator.clipboard.writeText(link); toast('Link copied'); }
      catch(e){ toast('Could not copy — long-press to copy manually'); }
    };
    document.getElementById('btnShareInviteLink').onclick = async ()=>{
      if(navigator.share){
        try{ await navigator.share({title:`Join ${activeGroup.name}`, url:link}); }
        catch(e){ /* user cancelled share sheet — no action needed */ }
      } else {
        try{ await navigator.clipboard.writeText(link); toast('Link copied'); }
        catch(e){ toast(link); }
      }
    };
  }

  function renderQr(text, elId='inviteQrCanvas'){
    const el = document.getElementById(elId);
    if(!el) return;
    el.innerHTML = '';
    if(window.QRCode){
      new window.QRCode(el, { text, width:180, height:180, colorDark:'#0a0e0f', colorLight:'#d7e5e2' });
    } else {
      el.innerHTML = '<p class="text-sm text-muted">QR code unavailable offline — share the link instead.</p>';
    }
  }

  /* ---------------- ntfy.sh push notifications ----------------
     Fully client-side, no backend of ours needed. Each group gets one
     fixed topic, generated once at creation time (see randomNtfyTopic())
     and stored on the group doc — not owner-editable, no server/token
     fields. Whichever member checks in POSTs a message straight to
     https://ntfy.sh/<topic>; anyone subscribed (via the ntfy app, or just
     ntfy.sh in a browser with background notifications enabled — no app
     install required either way) gets a real push, even with this app
     fully closed. That's the one thing the in-app Firestore-listener
     notifications above can't do. */
  function ntfySubscribeLink(topic){
    return `https://ntfy.sh/${encodeURIComponent(topic)}`;
  }

  async function publishNtfy(topic, {title, message, tags, priority=4}){
    if(!topic) return;
    try{
      await fetch('https://ntfy.sh/', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ topic, title, message, tags: tags||[], priority })
      });
    }catch(e){
      // Never block/interrupt the check-in flow over a notification
      // delivery failure — the completion itself already saved.
      console.error('ntfy publish failed', e);
    }
  }

  function showNtfySettingsSheet(){
    if(!activeGroup) return;
    ui().openSheet('sheetNtfySettings');
    renderNtfySettingsSheet();
  }

  function renderNtfySettingsSheet(){
    const isOwner = currentUser && activeGroup && activeGroup.ownerUid === currentUser.uid;
    const content = document.getElementById('ntfySettingsContent');
    const topic = activeGroup ? activeGroup.ntfyTopic : null;
    const link = topic ? ntfySubscribeLink(topic) : null;
    // The ntfy Android app registers the ntfy:// scheme and, per ntfy's own
    // docs, ntfy://<host>/<topic> opens straight to that topic's detail
    // view and subscribes automatically if not already subscribed — no
    // typing the topic name in by hand. Shown unconditionally rather than
    // gated on a user-agent sniff — that check is unreliable inside a TWA
    // wrapper anyway. Elsewhere it just won't resolve to anything, same as
    // tapping any link for an app that isn't installed.
    const androidAppLink = topic ? `ntfy://ntfy.sh/${encodeURIComponent(topic)}?display=${encodeURIComponent(activeGroup.name)}` : null;

    if(!topic){
      // Every group created going forward gets a topic automatically; this
      // only shows for groups created before this feature existed.
      content.innerHTML = `<p class="text-sm text-muted">Push notifications aren't available for this group — it was created before this feature existed.</p>`;
      return;
    }

    content.innerHTML = `
      <p class="text-sm text-muted mb-16">Get a real push notification — even with this app closed — whenever a teammate completes today's challenge. No app install required: open this group's ntfy page and tap <b>Subscribe</b>, then enable <b>background notifications</b> right there in the browser. (The <a href="https://ntfy.sh" target="_blank" rel="noopener" style="color:var(--accent);">ntfy app</a> works too, if you'd rather use it.)</p>
      <div class="invite-qr-wrap"><div id="ntfySubscribeQr"></div></div>
      <div class="invite-link-box">${escapeHtml(link)}</div>
      <button class="btn btn-primary btn-block mb-8" id="btnOpenNtfyAndroidApp">Open in ntfy Android app</button>
      <button class="btn btn-secondary btn-block mb-8" id="btnOpenNtfyLink">Open ntfy.sh in a new tab</button>
      <button class="btn btn-secondary btn-block" id="btnCopyNtfyLink">Copy link</button>
      ${isOwner ? `<button class="btn btn-secondary btn-block mt-8" id="btnTestNtfyConfig">Send test notification</button>` : ''}
    `;
    renderQr(link, 'ntfySubscribeQr');
    document.getElementById('btnOpenNtfyAndroidApp').addEventListener('click', ()=>{
      // A bare location change (not window.open) is what actually lets
      // Android's intent-resolution kick in for a custom scheme like this.
      window.location.href = androidAppLink;
    });
    document.getElementById('btnOpenNtfyLink').addEventListener('click', ()=>{
      window.open(link, '_blank', 'noopener');
    });
    document.getElementById('btnCopyNtfyLink').addEventListener('click', async ()=>{
      try{ await navigator.clipboard.writeText(link); toast('Link copied'); }
      catch(e){ toast('Could not copy — long-press to copy manually'); }
    });
    if(isOwner){
      document.getElementById('btnTestNtfyConfig').addEventListener('click', async ()=>{
        await publishNtfy(topic, {
          title: activeGroup.name,
          message: 'Test notification from Gym Tracker 👋',
          tags: ['bell']
        });
        toast('Test sent');
      });
    }
  }

  /* ---------------- group detail ---------------- */
  async function openGroup(groupId){
    activeGroupId = groupId;
    calCursor = new Date();
    document.getElementById('groupsPanelList').style.display = 'none';
    document.getElementById('groupsPanelInvite').style.display = 'none';
    document.getElementById('groupsPanelDetail').style.display = '';
    document.getElementById('groupDetailName').textContent = 'Loading…';
    document.getElementById('groupMembersRow').innerHTML = '';
    document.getElementById('groupChallengeCard').innerHTML = '';
    document.getElementById('calGroupGrid').innerHTML = '';
    seenCompletionKeys = new Set();
    notifiedThisSession = false;

    const gSnap = await getDoc(doc(db, 'groups', groupId));
    if(!gSnap.exists()){ toast('Group not found'); closeGroup(); return; }
    activeGroup = {id:groupId, ...gSnap.data()};
    document.getElementById('groupDetailName').textContent = activeGroup.name;

    teardownDetailListeners();

    membersUnsub = onSnapshot(collection(db, 'groups', groupId, 'members'), (snap)=>{
      activeMembers = snap.docs.map(d=>d.data()).sort((a,b)=>a.colorIndex-b.colorIndex);
      renderMembersRow();
      renderGroupCalendar(); // legend depends on members
      healOwnMemberDoc();
    });

    listenToActiveChallenge();
  }

  function teardownDetailListeners(){
    if(membersUnsub){ membersUnsub(); membersUnsub = null; }
    if(challengeUnsub){ challengeUnsub(); challengeUnsub = null; }
    if(completionsUnsub){ completionsUnsub(); completionsUnsub = null; }
  }

  function closeGroup(){
    teardownDetailListeners();
    activeGroupId = null; activeGroup = null; activeMembers = []; activeChallenge = null;
    completionsByDate = {};
    renderRoot();
  }

  function renderMembersRow(){
    const row = document.getElementById('groupMembersRow');
    row.innerHTML = activeMembers.map(m=>`
      <div class="group-member-chip" title="${escapeHtml(m.displayName)}">
        <span class="group-color-dot" style="background:${m.color}"></span>
        ${escapeHtml(firstName(m.displayName))}${isOwnerUid(m.uid) ? ' <span class="group-crown" title="Group owner">👑</span>' : ''}
      </div>
    `).join('') + (activeGroup && currentUser && activeGroup.ownerUid===currentUser.uid ? `<div class="group-member-chip group-member-chip-muted">${activeMembers.length}/${MAX_MEMBERS}</div>` : '');
    const leaveBtn = document.getElementById('btnLeaveGroup');
    leaveBtn.style.display = activeMembers.length ? '' : 'none';
  }

  function isOwnerUid(uid){
    return !!(activeGroup && activeGroup.ownerUid === uid);
  }

  function firstName(name){ return (name||'Member').split(' ')[0]; }

  // Repairs this user's own member doc if the name/photo it holds is stale
  // (e.g. saved before the auth-name bug fix, or the person renamed their
  // Google account since joining). Only ever touches the caller's own doc —
  // matches the Firestore rule that a member can update only themselves.
  async function healOwnMemberDoc(){
    if(!currentUser || !activeGroupId) return;
    const mine = activeMembers.find(m=>m.uid===currentUser.uid);
    if(!mine) return;
    const wantName = currentUser.name || 'Member';
    const wantPhoto = currentUser.photo || '';
    if(mine.displayName === wantName && (mine.photoURL||'') === wantPhoto) return;
    try{
      await updateDoc(doc(db, 'groups', activeGroupId, 'members', currentUser.uid), {
        displayName: wantName, photoURL: wantPhoto
      });
    }catch(e){ console.error('member doc heal failed', e); }
  }

  function listenToActiveChallenge(){
    const q = query(
      collection(db, 'groups', activeGroupId, 'challenges'),
      where('active', '==', true), limit(1)
    );
    challengeUnsub = onSnapshot(q, (snap)=>{
      if(snap.empty){
        activeChallenge = null;
        renderChallengeCard();
        if(completionsUnsub){ completionsUnsub(); completionsUnsub = null; }
        completionsByDate = {};
        renderGroupCalendar();
        return;
      }
      const chDoc = snap.docs[0];
      activeChallenge = {id:chDoc.id, ...chDoc.data()};
      renderChallengeCard();
      listenToCompletions();
    }, (err)=>console.error('challenge listen failed', err));
  }

  function renderChallengeCard(){
    const card = document.getElementById('groupChallengeCard');
    const isOwner = activeGroup && currentUser && activeGroup.ownerUid===currentUser.uid;
    if(!activeChallenge){
      card.innerHTML = `<div class="card" style="margin-bottom:16px;">
        <p class="text-sm text-muted mb-12">No active challenge yet.</p>
        ${isOwner ? '' : '<p class="text-sm text-faint">Waiting on the group owner to set one.</p>'}
      </div>`;
      document.getElementById('btnNewChallenge').style.display = isOwner ? '' : 'none';
      document.getElementById('btnMarkDoneToday').style.display = 'none';
      return;
    }
    document.getElementById('btnNewChallenge').style.display = isOwner ? '' : 'none';
    const today = todayISO();
    const inRange = today >= activeChallenge.startDate && today <= activeChallenge.endDate;
    const doneToday = (completionsByDate[today]||[]).some(c=>c.uid===currentUser.uid);
    card.innerHTML = `<div class="card" style="margin-bottom:16px;">
      <div class="settings-row-label">${escapeHtml(activeChallenge.title)}</div>
      ${activeChallenge.targetLabel ? `<div class="text-sm text-muted">${escapeHtml(activeChallenge.targetLabel)}</div>` : ''}
      <div class="text-sm text-faint mt-4">${fmtRange(activeChallenge.startDate, activeChallenge.endDate)}</div>
    </div>`;
    const btn = document.getElementById('btnMarkDoneToday');
    btn.style.display = inRange ? '' : 'none';
    btn.disabled = doneToday;
    btn.textContent = doneToday ? '✓ Done for today' : 'Mark today done';
  }

  function fmtRange(startIso, endIso){
    const opts = {month:'short', day:'numeric'};
    return `${parseISO(startIso).toLocaleDateString(undefined,opts)} – ${parseISO(endIso).toLocaleDateString(undefined,opts)}`;
  }

  async function createChallenge(){
    const title = document.getElementById('challengeTitleInput').value.trim();
    const targetLabel = document.getElementById('challengeTargetInput').value.trim();
    const startDate = document.getElementById('challengeStartInput').value;
    const endDate = document.getElementById('challengeEndInput').value;
    if(!title){ toast('Give the challenge a name'); return; }
    if(!startDate || !endDate || startDate > endDate){ toast('Check the challenge dates'); return; }
    try{
      // Deactivate any currently-active challenge, then create the new one —
      // one active challenge per group at a time keeps the calendar/completions
      // model simple (a completion always belongs to an unambiguous challenge).
      const existingQ = query(collection(db, 'groups', activeGroupId, 'challenges'), where('active','==',true));
      const existingSnap = await getDocs(existingQ);
      await Promise.all(existingSnap.docs.map(d=>updateDoc(d.ref, {active:false})));

      await addDoc(collection(db, 'groups', activeGroupId, 'challenges'), {
        title, targetLabel, startDate, endDate,
        createdBy: currentUser.uid, createdAt: Date.now(), active: true
      });
      ui().closeSheet('sheetNewChallenge');
      toast('Challenge created');
      if(activeGroup && activeGroup.ntfyTopic){
        publishNtfy(activeGroup.ntfyTopic, {
          title: activeGroup.name,
          message: `${firstName(currentUser.name)} set a new challenge: ${title}`,
          tags: ['triangular_flag_on_post']
        });
      }
    }catch(e){
      console.error(e);
      toast('Could not create challenge');
    }
  }

  /* ---------------- completions + calendar ---------------- */
  function listenToCompletions(){
    if(completionsUnsub){ completionsUnsub(); completionsUnsub = null; }
    const ref = collection(db, 'groups', activeGroupId, 'challenges', activeChallenge.id, 'completions');
    completionsUnsub = onSnapshot(ref, (snap)=>{
      const byDate = {};
      const currentKeys = new Set();
      snap.forEach(d=>{
        const c = d.data();
        currentKeys.add(d.id);
        (byDate[c.date] = byDate[c.date] || []).push(c);
      });
      completionsByDate = byDate;

      // Notify (foreground toast + Notification) about any check-in that's
      // new since the last snapshot and isn't the current user's own —
      // skipped on the very first snapshot after opening the group so
      // opening it doesn't fire a backlog of "notifications" for history.
      if(notifiedThisSession){
        currentKeys.forEach(key=>{
          if(seenCompletionKeys.has(key)) return;
          const c = snap.docs.find(d=>d.id===key).data();
          if(c.uid !== currentUser.uid){
            notifyTeammateCompletion(c);
          }
        });
      }
      seenCompletionKeys = currentKeys;
      notifiedThisSession = true;

      renderChallengeCard();
      renderGroupCalendar();
    }, (err)=>console.error('completions listen failed', err));
  }

  function notifyTeammateCompletion(c){
    toast(`${firstName(c.displayName)} completed today's challenge 🔥`);
    try{
      if('Notification' in window && Notification.permission==='granted'){
        new Notification(`${activeGroup.name}`, {
          body: `${firstName(c.displayName)} just completed today's challenge`,
          tag: 'group-completion-' + activeGroupId
        });
      }
    }catch(e){ /* notifications are a nice-to-have here, never fatal */ }
  }

  async function markTodayDone(){
    if(!activeChallenge || !currentUser) return;
    const date = todayISO();
    const id = `${date}_${currentUser.uid}`;
    try{
      await setDoc(doc(db, 'groups', activeGroupId, 'challenges', activeChallenge.id, 'completions', id), {
        uid: currentUser.uid,
        date,
        displayName: currentUser.name || 'Member',
        color: (activeMembers.find(m=>m.uid===currentUser.uid)||{}).color || PALETTE[0],
        completedAt: Date.now()
      });
      toast('Nice work — marked done for today');
      if(activeGroup && activeGroup.ntfyTopic){
        publishNtfy(activeGroup.ntfyTopic, {
          title: activeGroup.name,
          message: `${firstName(currentUser.name)} completed today's challenge: ${activeChallenge.title}`,
          tags: ['fire']
        });
      }
    }catch(e){
      console.error(e);
      toast('Could not save — try again');
    }
  }

  function renderGroupCalendar(){
    if(!activeGroupId) return;
    const year = calCursor.getFullYear(), month = calCursor.getMonth();
    document.getElementById('calGroupMonthLabel').textContent = calCursor.toLocaleDateString(undefined,{month:'long', year:'numeric'});

    const dowRow = document.getElementById('calGroupDowRow');
    dowRow.innerHTML = ['M','T','W','T','F','S','S'].map(d=>`<div class="cal-dow">${d}</div>`).join('');

    const grid = document.getElementById('calGroupGrid');
    const firstDay = new Date(year, month, 1);
    const startOffset = (firstDay.getDay()+6)%7;
    const daysInMonth = new Date(year, month+1, 0).getDate();
    const today = new Date();

    let cells = [];
    for(let i=0;i<startOffset;i++) cells.push(null);
    for(let d=1; d<=daysInMonth; d++) cells.push(d);

    grid.innerHTML = cells.map(d=>{
      if(d===null) return `<div class="cal-cell empty"></div>`;
      const cellDate = new Date(year,month,d);
      const iso = fmtISO(cellDate);
      const isToday = iso===fmtISO(today);
      const completions = completionsByDate[iso] || [];
      const dots = completions.slice(0,8).map(c=>`<span class="group-cal-dot" style="background:${c.color}"></span>`).join('');
      return `<div class="cal-cell ${isToday?'today':''} ${completions.length?'has-completions':''}" data-date="${iso}">
        <span class="num">${d}</span>
        <div class="group-cal-dots">${dots}</div>
      </div>`;
    }).join('');

    grid.querySelectorAll('.cal-cell[data-date]').forEach(cell=>{
      cell.addEventListener('click', ()=>openDaySheet(cell.dataset.date));
    });

    // Legend: one row per member and their color, so dot colors are readable
    // at a glance without needing to tap into every day.
    const legend = document.getElementById('calGroupLegend');
    legend.innerHTML = activeMembers.map(m=>`
      <div class="cal-legend-item"><div class="cal-legend-swatch" style="background:${m.color}; border:none;"></div>${escapeHtml(firstName(m.displayName))}</div>
    `).join('');
  }

  function openDaySheet(dateIso){
    const completions = completionsByDate[dateIso] || [];
    const completedUids = new Set(completions.map(c=>c.uid));
    const d = parseISO(dateIso);
    document.getElementById('dayCompletionsTitle').textContent = d.toLocaleDateString(undefined,{weekday:'long', month:'long', day:'numeric'});

    const list = document.getElementById('dayCompletionsList');
    if(activeMembers.length===0){
      list.innerHTML = `<p class="text-sm text-muted">No members yet.</p>`;
    } else {
      list.innerHTML = activeMembers.map(m=>{
        const done = completedUids.has(m.uid);
        return `<div class="row" style="padding:8px 0; border-bottom:1px solid var(--border-soft);">
          <div style="display:flex; align-items:center; gap:10px;">
            <span class="group-color-dot" style="background:${m.color}; opacity:${done?1:0.35};"></span>
            <span style="${done?'':'color:var(--text-faint);'}">${escapeHtml(m.displayName)}${isOwnerUid(m.uid) ? ' <span class="group-crown" title="Group owner">👑</span>' : ''}</span>
          </div>
          <span style="${done?'color:var(--positive);':'color:var(--text-faint);'} font-size:13px;">${done?'✓ Done':'—'}</span>
        </div>`;
      }).join('');
    }
    ui().openSheet('sheetDayCompletions');
  }

  function escapeHtml(s){
    return String(s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  document.addEventListener('DOMContentLoaded', init);
  if(document.readyState!=='loading') init();

  window.GymGroups = { onShow, getHomeChallengeCards, openGroupFromHome };
})();
