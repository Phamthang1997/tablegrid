//! The two backends of the Terminal panel (`TerminalPanel.tsx`): a local shell and a shell over SSH.
//!
//! They share a directory because they share ONE message protocol pushed to the frontend, so the
//! frontend has a single component for both — change the protocol on one side and forget the other
//! and that component breaks:
//!
//! ```text
//! { type: "data",   bytes: [...] }   output (a byte array; xterm decodes the UTF-8 itself)
//! { type: "exit",   code }           the shell exited (SSH only)
//! { type: "closed" }                the session has closed
//! ```

pub mod docker;
pub mod local;
pub mod ssh;
