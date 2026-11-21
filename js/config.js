// 部署 apps-script/Code.gs 後，把「網頁應用程式」網址貼在這裡（結尾是 /exec）。
window.APP_CONFIG = {
  API_URL: "https://script.google.com/macros/s/AKfycbx4LGPvd68p3VJjOCYrRDUMv4dfM86tq0LmBtozpImYwrzHUEGKerhKGXeStSlq4o69SA/exec",
  DEFAULT_TOPIC: "仿生共享嬰兒車",   // 試算表還沒設定主題時顯示這個
  POLL_MS: 3000,   // 多久向試算表同步一次（毫秒）
  SAVE_MS: 700,    // 停止輸入多久後自動儲存（毫秒）
};
