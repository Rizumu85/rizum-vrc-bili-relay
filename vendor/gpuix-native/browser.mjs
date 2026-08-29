/** Browser entry for the wasm-bindgen GPUI renderer. */
import init, { GpuixRenderer } from "./wasm/gpuix-web.js"
import wasmUrl from "./wasm/gpuix-web_bg.wasm" with { type: "file" }

await init({ module_or_path: wasmUrl })

export { GpuixRenderer }
