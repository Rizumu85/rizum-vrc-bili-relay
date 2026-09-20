use std::io::{self, BufRead, BufWriter, Read, Write};

use relay_core::{RelayCore, RequestEnvelope, ResponseEnvelope};

mod diagnostics;

const MAX_REQUEST_BYTES: usize = 1024 * 1024;

fn main() -> io::Result<()> {
    let mut core = RelayCore::new();
    let stdin = io::stdin();
    let mut stdout = BufWriter::new(io::stdout().lock());
    let mut line = Vec::new();
    let mut input = stdin.lock();

    loop {
        line.clear();
        // Bound allocation while reading, not after read_line has already
        // buffered an arbitrary amount of input without a newline.
        let count = (&mut input)
            .take((MAX_REQUEST_BYTES + 1) as u64)
            .read_until(b'\n', &mut line)?;
        if count == 0 {
            let _ = core.handle(relay_core::Command::Shutdown);
            break;
        }

        let response = if line.len() > MAX_REQUEST_BYTES {
            if line.last() != Some(&b'\n') {
                // Discard the remainder without allocating another large line.
                // Do not interpret its tail as a second executable command.
                input.skip_until(b'\n')?;
            }
            ResponseEnvelope::protocol_error("Request exceeds the 1 MiB protocol limit")
        } else {
            match serde_json::from_slice::<RequestEnvelope>(&line) {
                Ok(request) => {
                    let id = request.id;
                    let span = diagnostics::CommandSpan::begin(id, &request.command);
                    let result = core.handle(request.command);
                    span.finish(&result);
                    ResponseEnvelope::from_result(id, result)
                }
                Err(error) => {
                    ResponseEnvelope::protocol_error(format!("Invalid JSON request: {error}"))
                }
            }
        };

        let should_shutdown = matches!(
            &response,
            ResponseEnvelope::Ok { result, .. } if result.should_shutdown()
        );
        serde_json::to_writer(&mut stdout, &response)?;
        stdout.write_all(b"\n")?;
        stdout.flush()?;
        if should_shutdown {
            break;
        }
    }
    Ok(())
}
