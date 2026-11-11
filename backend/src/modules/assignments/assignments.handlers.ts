// The assignments module has no background jobs of its own: abandoned draft uploads are purged with their files by
// `files.purge`, and the offering copy runs through the content module's `content.copy` job. This file keeps the module
// layout uniform.
export {};
