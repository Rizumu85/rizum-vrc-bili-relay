//! FFmpeg parses an option list and then its surrounding filter graph separately.
//! Arguments are passed directly to Command, so there is no shell-escaping layer.
use std::path::Path;

fn escape(value: &str, punctuation: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for character in value.chars() {
        if punctuation.contains(character) || character.is_ascii_whitespace() {
            output.push('\\');
        }
        output.push(character);
    }
    output
}

/// One option-value layer, e.g. the argument to a ZMQ `drawtext reinit` command.
/// Do not wrap the result in single quotes: backslashes are literal inside them.
pub(crate) fn option_value(value: &str) -> String {
    escape(value, "\\':")
}

/// Both layers for a value embedded in a complete `-vf` graph.
pub(crate) fn graph_value(value: &str) -> String {
    escape(&option_value(value), "\\'[],;")
}

pub(crate) fn graph_path(path: &Path) -> String {
    graph_value(&path.to_string_lossy().replace('\\', "/"))
}

/// ZMQ's command parser consumes the entire reinit option list as one token.
/// This is a different outer layer from a filter graph (whitespace-delimited).
pub(crate) fn zmq_argument(options: &str) -> String {
    escape(options, "\\'")
}
