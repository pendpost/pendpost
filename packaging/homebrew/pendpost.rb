# pendpost Homebrew formula (source of truth).
#
# This belongs in a TAP repo named `pendpost/homebrew-tap`, at `Formula/pendpost.rb`,
# so users can run:  brew install pendpost/tap/pendpost
# It is kept here in the main repo as the canonical copy.
#
# First release (owner): npm publish must happen first (.github/workflows/
# release-npm.yml). Then create the tap repo, copy this file to Formula/pendpost.rb,
# and fill `url` + `sha256` for the published tarball. The quickest way:
#   brew create --tap pendpost/homebrew-tap https://registry.npmjs.org/pendpost/-/pendpost-<version>.tgz
# or compute the hash yourself:
#   curl -fsSL https://registry.npmjs.org/pendpost/-/pendpost-<version>.tgz | shasum -a 256
#
# Ongoing: bump on each release with `brew bump-formula-pr`, or wire the action in
# README.md so a published release opens the bump PR automatically.
class Pendpost < Formula
  desc "Local-first, MCP-native social media planner with a human approval gate"
  homepage "https://pendpost.com"
  url "https://registry.npmjs.org/pendpost/-/pendpost-1.0.0.tgz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/pendpost --version")
  end
end
