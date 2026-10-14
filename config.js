// Global Firebase Configuration
// If you want to connect 300 mobile phones across 4G/WiFi:
// 1. Create a free project at https://console.firebase.google.com
// 2. Add a Web App (</>) and paste your config keys below.
// 3. Enable 'Firestore Database' in Test Mode.
window.FIREBASE_CONFIG = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};

window.isFirebaseConfigured = function() {
  return window.FIREBASE_CONFIG && 
         window.FIREBASE_CONFIG.apiKey !== "YOUR_API_KEY" && 
         window.FIREBASE_CONFIG.projectId !== "YOUR_PROJECT_ID";
};
