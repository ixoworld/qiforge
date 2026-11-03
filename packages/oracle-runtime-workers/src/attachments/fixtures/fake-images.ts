/**
 * A fake Cloudflare Images binding for the attachment tests: `info()` reports
 * fixed dimensions (or SVG), and a transform outputs `output` bytes. Records the
 * bytes it was given and every transform/output option, so tests can prove
 * what reached the binding and that nothing else did. `fail` makes the named
 * step throw like a binding error.
 */
export interface FakeImages extends ImagesBinding {
  /** The bytes of each stream handed to `info()` / `input()`. */
  readonly seen: Uint8Array[];
  readonly transforms: ImageTransform[];
  readonly outputs: ImageOutputOptions[];
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function unused(): never {
  throw new Error('not used by the attachment pipeline');
}

export function fakeImages(opts: {
  width?: number;
  height?: number;
  svg?: boolean;
  output?: Uint8Array;
  fail?: 'info' | 'output';
}): FakeImages {
  const seen: Uint8Array[] = [];
  const transforms: ImageTransform[] = [];
  const outputs: ImageOutputOptions[] = [];
  const output = opts.output ?? new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 9]);
  const pending: Array<Promise<void>> = [];

  const transformer: ImageTransformer = {
    transform(transform) {
      transforms.push(transform);
      return transformer;
    },
    draw: unused,
    async output(options) {
      await Promise.all(pending);
      outputs.push(options);
      if (opts.fail === 'output') throw new Error('ImagesError 9422');
      return {
        response: () =>
          new Response(output, { headers: { 'content-type': options.format } }),
        contentType: () => options.format,
        image: () => new Response(output).body ?? new ReadableStream(),
      };
    },
  };

  return {
    seen,
    transforms,
    outputs,
    async info(stream) {
      seen.push(await drain(stream));
      if (opts.fail === 'info') throw new Error('ImagesError 9412');
      return opts.svg
        ? { format: 'image/svg+xml' }
        : {
            format: 'image/png',
            fileSize: 1,
            width: opts.width ?? 100,
            height: opts.height ?? 100,
          };
    },
    input(stream) {
      pending.push(
        drain(stream).then((bytes) => {
          seen.push(bytes);
        }),
      );
      return transformer;
    },
    text: unused,
    hosted: {
      image: unused,
      upload: unused,
      list: unused,
      createDirectUpload: unused,
    },
  };
}
