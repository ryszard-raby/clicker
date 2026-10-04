// Pass a dedicated directory: only numbered Clickator JSON logs are reset.
export function directoryLogger(directory) {
  return {
    async reset() {
      for await (const [name, handle] of directory.entries()) {
        if (handle.kind === 'file' && /^(request|response)-[1-9]\d*\.json$/.test(name)) {
          await this.write(name, { status: 'not_requested_in_current_session' });
        }
      }
    },
    async write(name, value) {
      if (!/^(request|response)-[1-9]\d*\.json$/.test(name)) throw new Error('Nieprawidłowa nazwa logu.');
      const file = await directory.getFileHandle(name, { create: true });
      const stream = await file.createWritable();
      try { await stream.write(JSON.stringify(value, null, 2) + '\n'); await stream.close(); }
      catch (error) { await stream.abort().catch(() => {}); throw error; }
    },
  };
}
