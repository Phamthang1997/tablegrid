//! Credentials: where they come from and where they are kept.
//!
//! These files share NO code — they share a concern. Grouping them gives the question
//! "where does the app keep its secrets, and how does it obtain them" exactly one place to be answered.
//!
//! `secret_store` is the API; `vault` is the second thing behind it, chosen when the user has turned
//! a master password on. Nothing outside these two decides between them.

pub mod aws_iam;
pub mod oauth;
pub mod secret_store;
pub mod vault;
