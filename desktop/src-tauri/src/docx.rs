//! The Word document Save writes for the ".docx" choice. The page hands the
//! app its text, never a file, so the app's commands never write bytes that
//! the page made; the app makes the document itself, byte for byte the one
//! the page's own writer makes in a browser (index.html, docxBytes). The
//! test at the end holds both to one sample (tests/fixtures at the
//! repository root, shared with the web suite; ledger D-43).

/// The three parts a .docx needs, before the document's text.
const CONTENT_TYPES: &str = concat!(
    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
    r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">"#,
    r#"<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>"#,
    r#"<Default Extension="xml" ContentType="application/xml"/>"#,
    r#"<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>"#,
    r#"</Types>"#
);
const RELATIONSHIPS: &str = concat!(
    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
    r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">"#,
    r#"<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>"#,
    r#"</Relationships>"#
);
const DOCUMENT_START: &str = concat!(
    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
    r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>"#
);
const DOCUMENT_END: &str = "</w:body></w:document>";

/// A Word document holding the text, one paragraph per line and a Word tab
/// for each tab, with no metadata (no author, no dates, no application name),
/// in a zip archive whose entries are stored, not compressed, and dated
/// 1 January 1980, so the file says nothing about when it was made.
/// Characters XML cannot hold are left out, and a carriage return, alone or
/// before a line feed, ends a paragraph as a line feed does (QA-F-05).
pub fn docx(text: &str) -> Result<Vec<u8>, String> {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut document = String::with_capacity(DOCUMENT_START.len() + text.len() * 2 + 64);
    document.push_str(DOCUMENT_START);
    for line in text.split('\n') {
        if line.is_empty() {
            document.push_str("<w:p/>");
            continue;
        }
        document.push_str(r#"<w:p><w:r><w:t xml:space="preserve">"#);
        for c in line.chars() {
            match c {
                '\u{0}'..='\u{8}'
                | '\u{B}'
                | '\u{C}'
                | '\u{E}'..='\u{1F}'
                | '\u{FFFE}'
                | '\u{FFFF}' => {}
                '&' => document.push_str("&amp;"),
                '<' => document.push_str("&lt;"),
                '>' => document.push_str("&gt;"),
                '\t' => document.push_str(r#"</w:t><w:tab/><w:t xml:space="preserve">"#),
                _ => document.push(c),
            }
        }
        document.push_str("</w:t></w:r></w:p>");
    }
    document.push_str(DOCUMENT_END);
    zip_stored(&[
        ("[Content_Types].xml", CONTENT_TYPES.as_bytes()),
        ("_rels/.rels", RELATIONSHIPS.as_bytes()),
        ("word/document.xml", document.as_bytes()),
    ])
}

/// A zip archive of the entries, stored, every entry dated 1 January 1980
/// at midnight, with UTF-8 names.
fn zip_stored(entries: &[(&str, &[u8])]) -> Result<Vec<u8>, String> {
    const DOS_DATE: u16 = 1 << 5 | 1; // 1980-01-01: year 0 since 1980, month 1, day 1
    let too_big = || "The text is too long for a Word document".to_owned();
    let mut out = Vec::new();
    let mut central = Vec::new();
    for &(name, data) in entries {
        let offset = u32::try_from(out.len()).map_err(|_| too_big())?;
        let size = u32::try_from(data.len()).map_err(|_| too_big())?;
        let name_len = u16::try_from(name.len()).map_err(|_| too_big())?;
        // Version needed 2.0, UTF-8 names, stored, the time and the date, the
        // checksum, both sizes, the name's length and no extra field.
        let mut common = Vec::with_capacity(26);
        for v in [20u16, 0x0800, 0, 0, DOS_DATE] {
            common.extend_from_slice(&v.to_le_bytes());
        }
        for v in [crc32(data), size, size] {
            common.extend_from_slice(&v.to_le_bytes());
        }
        for v in [name_len, 0] {
            common.extend_from_slice(&v.to_le_bytes());
        }
        out.extend_from_slice(&0x0403_4B50u32.to_le_bytes());
        out.extend_from_slice(&common);
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(data);
        central.extend_from_slice(&0x0201_4B50u32.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes()); // made by: version 2.0
        central.extend_from_slice(&common);
        // No comment, disk 0, no internal or external attributes, then where
        // the entry starts.
        for v in [0u16, 0, 0] {
            central.extend_from_slice(&v.to_le_bytes());
        }
        central.extend_from_slice(&0u32.to_le_bytes());
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name.as_bytes());
    }
    let count = u16::try_from(entries.len()).map_err(|_| too_big())?;
    let central_size = u32::try_from(central.len()).map_err(|_| too_big())?;
    let central_start = u32::try_from(out.len()).map_err(|_| too_big())?;
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x0605_4B50u32.to_le_bytes());
    for v in [0u16, 0, count, count] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out.extend_from_slice(&central_size.to_le_bytes());
    out.extend_from_slice(&central_start.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // no archive comment
    Ok(out)
}

/// The zip archive's checksum (CRC-32, the polynomial 0xEDB88320).
fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in bytes {
        crc ^= u32::from(b);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                0xEDB8_8320 ^ (crc >> 1)
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_app_makes_the_same_document_as_the_page() {
        // sample.docx is what the page's own writer made from sample.txt
        // (tests/fixtures at the repository root, shared with the web suite);
        // desktop/tests/native.mjs checks the page against the same file.
        let text = include_str!("../../../tests/fixtures/sample.txt");
        let page = include_bytes!("../../../tests/fixtures/sample.docx");
        assert_eq!(docx(text).unwrap(), page.to_vec());
    }

    #[test]
    fn the_checksum_is_the_standard_crc32() {
        assert_eq!(crc32(b""), 0);
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn an_empty_text_is_one_empty_paragraph_in_a_whole_archive() {
        let bytes = docx("").unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("<w:body><w:p/></w:body>"));
        assert_eq!(&bytes[..4], b"PK\x03\x04", "a zip archive");
        let end = bytes.len() - 22;
        assert_eq!(
            &bytes[end..end + 4],
            b"PK\x05\x06",
            "with its directory at the end"
        );
        assert_eq!(
            u16::from_le_bytes([bytes[end + 10], bytes[end + 11]]),
            3,
            "three parts"
        );
    }

    /// A carriage return can only reach the writer from a hand-made .sight
    /// file; written raw inside <w:t> it turned into a space in some readers
    /// (QA-F-05). Both "\r\n" and a lone "\r" end a paragraph, like "\n".
    #[test]
    fn carriage_returns_end_paragraphs_like_line_feeds() {
        assert_eq!(
            docx("one\r\ntwo\rthree\n\rfour").unwrap(),
            docx("one\ntwo\nthree\n\nfour").unwrap()
        );
        let bytes = docx("a\rb").unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(
            !text.contains('\r'),
            "no raw carriage return in the document"
        );
        assert_eq!(text.matches("<w:p>").count(), 2, "two paragraphs");
    }

    #[test]
    fn markup_in_the_text_stays_text() {
        let bytes = docx("<w:p>&amp;</w:p>\t").unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains(r#"<w:t xml:space="preserve">&lt;w:p&gt;&amp;amp;&lt;/w:p&gt;</w:t><w:tab/><w:t xml:space="preserve"></w:t>"#));
    }
}
