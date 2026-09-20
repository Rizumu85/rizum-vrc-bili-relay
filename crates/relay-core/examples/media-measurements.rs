// Helper for benchmarks/media-pipeline.bench.ts; not a test runner.
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let report = match relay_core::media_measurements::run(&args) {
        Ok(report) => report,
        Err(error) => serde_json::json!({ "measurement_error": error }),
    };
    println!("{}", report);
}
