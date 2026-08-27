use crate::RelayError;

const ENTROPY: &[u8] = b"VRC Bili Relay stream key v1";

#[cfg(windows)]
pub(crate) fn protect(plaintext: &str) -> Result<String, RelayError> {
    protect_bytes(plaintext.as_bytes()).map(|bytes| encode_hex(&bytes))
}

#[cfg(not(windows))]
pub(crate) fn protect(_plaintext: &str) -> Result<String, RelayError> {
    Err(RelayError::new(
        "settings_encryption_unavailable",
        "Windows user-scoped encryption is unavailable on this platform",
    ))
}

#[cfg(windows)]
pub(crate) fn unprotect(protected: &str) -> Result<String, ()> {
    let encoded = decode_hex(protected)?;
    let mut plaintext = unprotect_bytes(&encoded).map_err(|_| ())?;
    match String::from_utf8(plaintext) {
        Ok(decoded) => Ok(decoded),
        Err(error) => {
            plaintext = error.into_bytes();
            plaintext.fill(0);
            Err(())
        }
    }
}

#[cfg(not(windows))]
pub(crate) fn unprotect(_protected: &str) -> Result<String, ()> {
    Err(())
}

#[cfg(windows)]
fn protect_bytes(input: &[u8]) -> Result<Vec<u8>, RelayError> {
    use std::ptr;

    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData,
    };

    let input_length = u32::try_from(input.len()).map_err(|_| {
        RelayError::new(
            "settings_encryption_failed",
            "The stream key is too large for Windows encryption",
        )
    })?;
    let entropy_length = u32::try_from(ENTROPY.len()).expect("DPAPI entropy fits in u32");
    let input_blob = CRYPT_INTEGER_BLOB {
        cbData: input_length,
        pbData: input.as_ptr().cast_mut(),
    };
    let entropy_blob = CRYPT_INTEGER_BLOB {
        cbData: entropy_length,
        pbData: ENTROPY.as_ptr().cast_mut(),
    };
    let mut output_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };

    // SAFETY: Every pointer is valid for the duration of the call. DPAPI allocates
    // output_blob with LocalAlloc, and the buffer is copied before LocalFree.
    let succeeded = unsafe {
        CryptProtectData(
            &input_blob,
            ptr::null(),
            &entropy_blob,
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output_blob,
        )
    };
    if succeeded == 0 {
        // SAFETY: GetLastError has no preconditions and is read immediately after
        // the failed Win32 call.
        let code = unsafe { GetLastError() };
        return Err(RelayError::new(
            "settings_encryption_failed",
            format!("Windows could not encrypt the stream key (error {code})"),
        ));
    }

    let output = copy_and_free(output_blob.pbData, output_blob.cbData);
    output.ok_or_else(|| {
        RelayError::new(
            "settings_encryption_failed",
            "Windows returned an invalid encrypted stream key",
        )
    })
}

#[cfg(windows)]
fn unprotect_bytes(input: &[u8]) -> Result<Vec<u8>, u32> {
    use std::ptr;

    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData,
    };

    let input_length = u32::try_from(input.len()).map_err(|_| u32::MAX)?;
    let entropy_length = u32::try_from(ENTROPY.len()).expect("DPAPI entropy fits in u32");
    let input_blob = CRYPT_INTEGER_BLOB {
        cbData: input_length,
        pbData: input.as_ptr().cast_mut(),
    };
    let entropy_blob = CRYPT_INTEGER_BLOB {
        cbData: entropy_length,
        pbData: ENTROPY.as_ptr().cast_mut(),
    };
    let mut output_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };

    // SAFETY: The input and entropy pointers remain valid for the call. No data
    // description is requested, so there is no second allocation to release.
    let succeeded = unsafe {
        CryptUnprotectData(
            &input_blob,
            ptr::null_mut(),
            &entropy_blob,
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output_blob,
        )
    };
    if succeeded == 0 {
        // SAFETY: GetLastError has no preconditions and is read immediately after
        // the failed Win32 call.
        return Err(unsafe { GetLastError() });
    }

    copy_and_free(output_blob.pbData, output_blob.cbData).ok_or(u32::MAX)
}

#[cfg(windows)]
fn copy_and_free(pointer: *mut u8, length: u32) -> Option<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;

    if pointer.is_null() {
        return (length == 0).then(Vec::new);
    }
    // SAFETY: DPAPI returned a buffer of exactly `length` bytes. The copy is
    // completed before the matching LocalFree call.
    let output = unsafe { std::slice::from_raw_parts(pointer, length as usize).to_vec() };
    // SAFETY: DPAPI documents that its output buffer must be released by
    // LocalFree. The pointer has not previously been freed.
    unsafe {
        LocalFree(pointer.cast());
    }
    Some(output)
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn decode_hex(value: &str) -> Result<Vec<u8>, ()> {
    if !value.len().is_multiple_of(2) {
        return Err(());
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let high = decode_nibble(pair[0])?;
            let low = decode_nibble(pair[1])?;
            Ok((high << 4) | low)
        })
        .collect()
}

fn decode_nibble(value: u8) -> Result<u8, ()> {
    match value {
        b'0'..=b'9' => Ok(value - b'0'),
        b'a'..=b'f' => Ok(value - b'a' + 10),
        b'A'..=b'F' => Ok(value - b'A' + 10),
        _ => Err(()),
    }
}
