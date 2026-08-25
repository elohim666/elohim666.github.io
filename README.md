# 3l0h1m.s3c

Security research blog. ELF/objdump-inspired terminal aesthetic.

Built with [Hugo](https://gohugo.io/), deployed on GitHub Pages.

## Local Development

```bash
# install hugo (macOS)
brew install hugo

# install hugo (Linux)
# download from https://github.com/gohugoio/hugo/releases

# run local server
hugo server -D

# open http://localhost:1313
```

## Writing a Post

```bash
# create new post
hugo new posts/my-new-post.md

# edit content/posts/my-new-post.md
# set draft: false when ready to publish
```

### Code Blocks

Just use standard markdown fenced code blocks:

````
```c
int main(void) {
    printf("hello world\n");
    return 0;
}
```
````

### Images / Screenshots

Use the `img` shortcode:

```
{{< img src="/img/screenshot.png" path="/tmp/memdump.png" caption="fig.1 — memory dump" >}}
```

- `src` — path to image in `/static/img/`
- `path` — fake file path displayed above (terminal aesthetic)
- `caption` — description below the image

### Notes / Warnings

```
{{< note >}}
This is an important note.
{{< /note >}}
```

## Deploy

Push to `main` branch. GitHub Actions builds and deploys automatically.

### First-time GitHub Pages setup

1. Create repo `yourusername.github.io` (or any repo name)
2. Push this code to `main`
3. Go to repo Settings → Pages → Source → GitHub Actions
4. The workflow runs on push and deploys to `https://yourusername.github.io/`
