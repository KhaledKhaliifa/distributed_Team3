// Import Firebase modules:
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.6/firebase-app.js";
import { getDatabase, set, get, ref, query, onValue, child, push, remove, onDisconnect } from "https://www.gstatic.com/firebasejs/9.6.6/firebase-database.js";

// Firebase configuration:
const firebaseConfig = {
  apiKey: "AIzaSyBmwruzGgrCRJBalfo0dtta3Eu9qQ3d02M",
  authDomain: "distributed-text-editor-dc48e.firebaseapp.com",
  projectId: "distributed-text-editor-dc48e",
  storageBucket: "distributed-text-editor-dc48e.appspot.com",
  messagingSenderId: "229680002194",
  appId: "1:229680002194:web:21932142c96df2eb43a24b"
};


// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

let pending = [];
let applied = [];
let uid = "User" + getCurrentTime().toString() + Math.floor(Math.random() * Math.pow(10, 5)).toString();
let lastKeyPress;
let lastChange;
let lastUpdated;
let prevContentUpdated = 0;
let contentCheck = 0;
let lastInputTimeStamp = 0;
let activeVertex = false;
let stack = {
  undo: [],
  redo: []
};
let userCache = {};
let actvStyles = [];

let contentCheckDelay = 5;
let syncCount = 0;