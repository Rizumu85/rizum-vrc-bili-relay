use std::io::{self, BufRead, BufWriter, Write};

use relay_core::{RelayCore, RequestEnvelope, ResponseEnvelope};

const MAX_REQUEST_BYTES: usize = 1024 * 1024;

fn main() -> io::Result<()> {
    let core = RelayCore::new();
    let stdin = io::stdin();
    let mut stdout = BufWriter::new(io::stdout().lock());
    let mut line = String::new();
    let mut input = stdin.lock();

    loop {
        line.clear();
        if input.read_line(&mut line)? == 0 {
            break;
        }

        let response = if line.len() > MAX_REQUEST_BYTES {
            ResponseEnvelope::protocol_error("Request exceeds the 1 MiB protocol limit")
        } else {
            match serde_json::from_str::<RequestEnvelope>(&line) {
                Ok(request) => {
                    let id = request.id;
                    ResponseEnvelope::from_result(id, core.handle(request.command))
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
