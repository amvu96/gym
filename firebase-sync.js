/* ============================================================
   FIREBASE SYNC LAYER
   Adds Google sign-in and cross-device sync on top of the
   existing localStorage-first app. The app works fully offline
   and without an account; signing in layers sync on top.

   Contract with app.js:
   - window.GymSync.init(onAuthChange, onRemoteChange) is called once
     app.js has its state ready.
   - app.js calls window.GymSync.push(state) after every local saveState().
   - window.GymSync fires onRemoteChange(remoteState) when data arrives
     from another device, so app.js can merge and re-render.
   ============================================================ */
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, onSnapshot
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

(function(){
  'use strict';

  if(!window.FIREBASE_CONFIG || window.FIREBASE_CONFIG.apiKey === "PASTE_YOUR_API_KEY"){
    console.warn('Firebase config not set — sign-in and cloud sync are disabled. Edit firebase-config.js.');
    window.GymSync = {
      init(){}, push(){}, signIn(){ alert('Cloud sync is not configured yet.'); }, signOut(){},
      isSignedIn(){ return false; }
    };
    return;
  }

  const app = initializeApp(window.FIREBASE_CONFIG);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const provider = new GoogleAuthProvider();

  let currentUser = null;
  let unsubscribeSnapshot = null;
  let onRemoteChangeCb = null;
  let onAuthChangeCb = null;
  let pushDebounceTimer = null;
  let lastPushedJson = null; // avoids echoing our own writes back through onSnapshot
  let suppressNextSnapshot = false;

  function userDocRef(uid){
    return doc(db, 'users', uid);
  }

  async function signIn(){
    try{
      await signInWithPopup(auth, provider);
    }catch(e){
      console.error('Sign-in failed', e);
      if(e.code === 'auth/popup-blocked'){
        alert('Your browser blocked the sign-in popup. Please allow popups for this site and try again.');
      } else if(e.code !== 'auth/popup-closed-by-user'){
        alert('Sign-in failed: ' + (e.message || e.code));
      }
    }
  }

  async function doSignOut(){
    if(unsubscribeSnapshot){ unsubscribeSnapshot(); unsubscribeSnapshot = null; }
    await signOut(auth);
  }

  function push(state){
    if(!currentUser) return;
    clearTimeout(pushDebounceTimer);
    pushDebounceTimer = setTimeout(async ()=>{
      try{
        const json = JSON.stringify(state);
        if(json === lastPushedJson) return; // nothing changed since last push
        lastPushedJson = json;
        suppressNextSnapshot = true;
        await setDoc(userDocRef(currentUser.uid), {
          data: state,
          updatedAt: Date.now()
        });
      }catch(e){
        console.error('Cloud sync push failed', e);
      }
    }, 800);
  }

  function listenForRemoteChanges(uid){
    if(unsubscribeSnapshot) unsubscribeSnapshot();
    unsubscribeSnapshot = onSnapshot(userDocRef(uid), (snap)=>{
      if(suppressNextSnapshot){
        // this snapshot is just an echo of our own push; ignore it once
        suppressNextSnapshot = false;
        return;
      }
      if(!snap.exists()) return;
      const remote = snap.data();
      if(remote && remote.data && onRemoteChangeCb){
        onRemoteChangeCb(remote.data);
      }
    }, (err)=>{
      console.error('Cloud sync listener error', err);
    });
  }

  async function pullInitial(uid){
    try{
      const snap = await getDoc(userDocRef(uid));
      if(snap.exists() && snap.data() && snap.data().data){
        return snap.data().data;
      }
      return null;
    }catch(e){
      console.error('Initial cloud fetch failed', e);
      return null;
    }
  }

  function init(onAuthChange, onRemoteChange){
    onAuthChangeCb = onAuthChange;
    onRemoteChangeCb = onRemoteChange;
    onAuthStateChanged(auth, async (user)=>{
      currentUser = user;
      if(user){
        const remoteState = await pullInitial(user.uid);
        listenForRemoteChanges(user.uid);
        onAuthChangeCb({signedIn:true, user:{name:user.displayName, email:user.email, photo:user.photoURL}, remoteState});
      } else {
        if(unsubscribeSnapshot){ unsubscribeSnapshot(); unsubscribeSnapshot = null; }
        lastPushedJson = null;
        onAuthChangeCb({signedIn:false});
      }
    });
  }

  window.GymSync = {
    init,
    push,
    signIn,
    signOut: doSignOut,
    isSignedIn(){ return !!currentUser; }
  };
})();
