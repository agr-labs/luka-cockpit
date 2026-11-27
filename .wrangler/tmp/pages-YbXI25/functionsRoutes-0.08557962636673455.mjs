import { onRequestGet as __api_metrics_export_js_onRequestGet } from "/Users/toby/a2-cockpit/functions/api/metrics/export.js"
import { onRequestOptions as __api_metrics_export_js_onRequestOptions } from "/Users/toby/a2-cockpit/functions/api/metrics/export.js"
import { onRequestGet as __api_metrics_summary_js_onRequestGet } from "/Users/toby/a2-cockpit/functions/api/metrics/summary.js"
import { onRequestOptions as __api_metrics_summary_js_onRequestOptions } from "/Users/toby/a2-cockpit/functions/api/metrics/summary.js"
import { onRequestOptions as __api_metrics_js_onRequestOptions } from "/Users/toby/a2-cockpit/functions/api/metrics.js"
import { onRequestPost as __api_metrics_js_onRequestPost } from "/Users/toby/a2-cockpit/functions/api/metrics.js"

export const routes = [
    {
      routePath: "/api/metrics/export",
      mountPath: "/api/metrics",
      method: "GET",
      middlewares: [],
      modules: [__api_metrics_export_js_onRequestGet],
    },
  {
      routePath: "/api/metrics/export",
      mountPath: "/api/metrics",
      method: "OPTIONS",
      middlewares: [],
      modules: [__api_metrics_export_js_onRequestOptions],
    },
  {
      routePath: "/api/metrics/summary",
      mountPath: "/api/metrics",
      method: "GET",
      middlewares: [],
      modules: [__api_metrics_summary_js_onRequestGet],
    },
  {
      routePath: "/api/metrics/summary",
      mountPath: "/api/metrics",
      method: "OPTIONS",
      middlewares: [],
      modules: [__api_metrics_summary_js_onRequestOptions],
    },
  {
      routePath: "/api/metrics",
      mountPath: "/api",
      method: "OPTIONS",
      middlewares: [],
      modules: [__api_metrics_js_onRequestOptions],
    },
  {
      routePath: "/api/metrics",
      mountPath: "/api",
      method: "POST",
      middlewares: [],
      modules: [__api_metrics_js_onRequestPost],
    },
  ]