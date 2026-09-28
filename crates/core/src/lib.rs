//! Orchevia core: workflow domain model, persistence, process execution, tool discovery.
//!
//! This crate is intentionally free of Tauri/GUI dependencies so the complete
//! business logic can be unit-tested on any machine without system webview
//! libraries installed.

pub mod agents;
pub mod conditions;
pub mod db;
pub mod engine;
pub mod generation;
pub mod git;
pub mod github;
pub mod mcp;
pub mod memory;
pub mod notify;
pub mod process;
pub mod prompt;
pub mod review;
pub mod schedule;
pub mod scheduler;
pub mod templates;
pub mod ticket;
pub mod tools;
pub mod trust;
pub mod workflow;

pub use agents::AgentProfile;
pub use db::SqliteDb;
pub use workflow::{
    Edge, Node, NodeConfig, NodeKind, Position, ValidationIssue, ValidationSeverity, Workflow,
    CURRENT_SCHEMA_VERSION,
};
