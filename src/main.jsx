import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App.jsx";
import { readTextSize, applyTextSize } from "./textSize.js";

// 文字の大きさは描画前に反映して、ちらつかないようにする
applyTextSize(readTextSize() || "normal");

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
